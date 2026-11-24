/**
 * Per-serving macros (calories, protein, carbs, fat, fiber) for a plan's meals, from the USDA's
 * free FoodData Central database (https://fdc.nal.usda.gov).
 *
 * 1. One small Haiku call turns each ingredient ("2 lb chicken thighs") into grams and a
 *    USDA-style food name ("Chicken, thigh, meat only, raw").
 * 2. Each food name is looked up in FoodData Central once, and a second small Haiku call picks the
 *    right result (search alone can't tell "rice" from "rice crackers"). The pick is cached in
 *    Firestore (nutritionFoods/{name}), so a food is only ever looked up once for everyone.
 * 3. Nutrients per 100 g x grams, added up per meal and divided by servings.
 *
 * The numbers come from USDA data; the model only converts amounts and picks foods.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { ModelPlan } from "./plan";

export const NUTRITION_MODEL = "claude-haiku-5-5";
/** Bump when the way macros are worked out changes, so old ones can be redone. */
export const MACROS_VERSION = 1;
const FDC_SEARCH = "https://api.nal.usda.gov/fdc/v1/foods/search";
/** Generic foods with nutrients per 100 g. Branded foods are left out (per-package labels, millions of near-duplicates). */
const FDC_DATA_TYPES = "Foundation,SR Legacy,Survey (FNDDS)";
const CACHE = "nutritionFoods";

export interface Macros {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber: number;
}

export interface MealMacros {
  /** Per serving: kcal, and grams of protein, carbs, fat, fiber. */
  perServing: Macros;
  servings: number;
  /** Ingredients we found in USDA data, out of all ingredients with a weight. */
  matched: number;
  ingredientCount: number;
  /** Share of the meal's weight we have nutrients for, 0 to 1. Below about 0.8 the numbers run low. */
  coverage: number;
  ingredients: {
    item: string;
    amount: string;
    grams: number | null;
    food: string | null;
    fdcId: number | null;
  }[];
  source: "USDA FoodData Central";
  version: number;
  computedAt: string;
}

type Meal = Pick<ModelPlan["meals"][number], "name" | "servings" | "ingredients">;

interface CachedFood {
  query: string;
  fdcId: number | null;
  description: string | null;
  dataType: string | null;
  per100g: Macros | null;
  savedAt: string;
}

const GramsSchema = z.object({
  ingredients: z.array(
    z.object({
      ing: z.number().int().describe("The ING number"),
      grams: z.number().nullable().describe("Total grams of this ingredient for the whole recipe, as bought (raw), or null if it can't be weighed"),
      food: z
        .string()
        .nullable()
        .describe('USDA FoodData Central style name, e.g. "Chicken, thigh, meat only, raw" or "Rice, white, long-grain, regular, raw". Null for water, ice or salt-free seasoning to taste.'),
    })
  ),
});

const GRAMS_SYSTEM = `You convert recipe ingredients to weights so their nutrition can be looked up.
For each ING, give the total grams the recipe uses (raw, edible portion as bought; e.g. 2 lb = 907, 1 cup dry long-grain rice = 185, 1 medium onion = 110, 1 clove garlic = 3, 1 tbsp oil = 13.5, 1 can (15 oz) black beans drained = 240).
For "food", write the plain generic food the way the USDA names it: main food first, then form and state, raw for meats and produce. No brands.
Use null grams only when an amount truly can't be estimated (e.g. "to taste"); use null food for water and ice.`;

const PickSchema = z.object({
  picks: z.array(
    z.object({
      food: z.number().int().describe("The FOOD number"),
      choice: z.string().nullable().describe("Letter of the matching USDA food, or null if none is the same food"),
    })
  ),
});

const PICK_SYSTEM = `You match food names to USDA FoodData Central entries so their nutrition can be used.
For each FOOD, pick the letter of the entry that is the same food in the same form (raw vs cooked, with or without skin, dry vs canned).
Never pick a different food that shares a word ("rice" is not "rice crackers"; "chicken broth" is not "chicken"). Use null if nothing fits.`;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Firestore doc id for a food name: lowercase words, no slashes. */
export function foodKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 120);
}

interface FdcFood {
  fdcId: number;
  description: string;
  dataType: string;
  foodNutrients?: { nutrientNumber?: string; nutrientId?: number; unitName?: string; value?: number }[];
}

/** Nutrients per 100 g from a FoodData Central search result. Null if it has no energy value. */
export function per100g(food: FdcFood): Macros | null {
  const byNumber = new Map<string, { unit: string; value: number }>();
  for (const n of food.foodNutrients ?? []) {
    if (n.nutrientNumber && typeof n.value === "number") {
      byNumber.set(n.nutrientNumber, { unit: (n.unitName ?? "").toUpperCase(), value: n.value });
    }
  }
  const get = (num: string) => byNumber.get(num)?.value ?? 0;
  // Energy: 208 is kcal. Some Foundation foods only have the Atwater values (958 specific, 957 general).
  let calories: number | null = null;
  for (const num of ["208", "958", "957"]) {
    const e = byNumber.get(num);
    if (e && e.unit === "KCAL") {
      calories = e.value;
      break;
    }
  }
  if (calories === null) {
    const kj = byNumber.get("268");
    if (kj) calories = kj.value / 4.184;
  }
  if (calories === null) return null;
  return { calories, protein: get("203"), carbs: get("205"), fat: get("204"), fiber: get("291") };
}

async function searchFdc(query: string, apiKey: string): Promise<FdcFood[]> {
  const url = new URL(FDC_SEARCH);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("query", query);
  url.searchParams.set("dataType", FDC_DATA_TYPES);
  url.searchParams.set("pageSize", "6");
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`FoodData Central search failed: HTTP ${res.status}`);
  const body = (await res.json()) as { foods?: FdcFood[] };
  return (body.foods ?? []).filter((f) => per100g(f) !== null);
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}

export interface MacrosResult {
  macros: Record<string, MealMacros>;
  inputTokens: number;
  outputTokens: number;
  /** Foods looked up in FoodData Central this time (the rest came from the cache). */
  lookups: number;
}

/**
 * Works out per-serving macros for each meal, keyed by meal name.
 * Throws only if the first model call fails; foods that can't be found just count as unmatched.
 */
export async function computeMealMacros(
  db: Firestore,
  anthropic: Anthropic,
  meals: Meal[],
  fdcApiKey: string
): Promise<MacrosResult> {
  let inputTokens = 0;
  let outputTokens = 0;

  // 1. Grams and USDA-style names for every ingredient.
  const flat: { meal: number; ing: Meal["ingredients"][number] }[] = [];
  meals.forEach((m, mi) => m.ingredients.forEach((ing) => flat.push({ meal: mi, ing })));
  const lines = flat.map(
    (f, i) => `ING ${i + 1}: ${f.ing.amount ? `${f.ing.amount} ` : ""}${f.ing.item}  (in "${meals[f.meal].name}", serves ${meals[f.meal].servings})`
  );
  const gramsResponse = await anthropic.beta.messages.parse({
    model: NUTRITION_MODEL,
    max_tokens: 8000,
    output_config: { format: betaZodOutputFormat(GramsSchema) },
    system: GRAMS_SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  inputTokens += gramsResponse.usage.input_tokens;
  outputTokens += gramsResponse.usage.output_tokens;
  const conv: { grams: number | null; food: string | null }[] = flat.map(() => ({ grams: null, food: null }));
  for (const c of gramsResponse.parsed_output?.ingredients ?? []) {
    const i = c.ing - 1;
    if (!conv[i]) continue;
    const grams = typeof c.grams === "number" && c.grams > 0 ? Math.min(c.grams, 5000) : null;
    const food = c.food && foodKey(c.food) ? c.food.trim().slice(0, 120) : null;
    conv[i] = { grams, food };
  }

  // 2. Foods: from the cache, or looked up and picked now.
  const keys = [...new Set(conv.map((c) => (c.food ? foodKey(c.food) : "")).filter(Boolean))];
  const foods = new Map<string, CachedFood>();
  if (keys.length) {
    const snaps = await db.getAll(...keys.map((k) => db.collection(CACHE).doc(k)));
    snaps.forEach((s) => s.exists && foods.set(s.id, s.data() as CachedFood));
  }
  const missing = keys.filter((k) => !foods.has(k));
  const nameFor = new Map(conv.filter((c) => c.food).map((c) => [foodKey(c.food!), c.food!]));
  const searched = await mapLimit(missing, 4, async (k) => {
    try {
      return { key: k, results: await searchFdc(nameFor.get(k) ?? k, fdcApiKey) };
    } catch (err) {
      // Not cached, so it's tried again next time (e.g. after a rate limit).
      console.warn("FoodData Central lookup failed", k, (err as Error).message);
      return { key: k, results: null };
    }
  });
  const letters = "abcdef";
  const toPick = searched.filter((s): s is { key: string; results: FdcFood[] } => s.results !== null);
  const picked = new Map<string, FdcFood | null>();
  for (const s of toPick) if (s.results.length === 0) picked.set(s.key, null);
  const withChoices = toPick.filter((s) => s.results.length > 0);
  if (withChoices.length) {
    const pickLines: string[] = [];
    withChoices.forEach((s, i) => {
      pickLines.push(`FOOD ${i + 1}: ${nameFor.get(s.key) ?? s.key}`);
      s.results.forEach((f, j) => pickLines.push(`  ${letters[j]}) ${f.description}`));
    });
    try {
      const pickResponse = await anthropic.beta.messages.parse({
        model: NUTRITION_MODEL,
        max_tokens: 3000,
        output_config: { format: betaZodOutputFormat(PickSchema) },
        system: PICK_SYSTEM,
        messages: [{ role: "user", content: pickLines.join("\n") }],
      });
      inputTokens += pickResponse.usage.input_tokens;
      outputTokens += pickResponse.usage.output_tokens;
      for (const p of pickResponse.parsed_output?.picks ?? []) {
        const s = withChoices[p.food - 1];
        if (!s) continue;
        const idx = p.choice ? letters.indexOf(p.choice.trim().toLowerCase()) : -1;
        picked.set(s.key, idx >= 0 ? s.results[idx] ?? null : null);
      }
    } catch (err) {
      console.warn("Food pick failed", (err as Error).message);
    }
  }
  if (picked.size) {
    const now = new Date().toISOString();
    const batch = db.batch();
    for (const [key, f] of picked) {
      const doc: CachedFood = {
        query: nameFor.get(key) ?? key,
        fdcId: f?.fdcId ?? null,
        description: f?.description ?? null,
        dataType: f?.dataType ?? null,
        per100g: f ? per100g(f) : null,
        savedAt: now,
      };
      foods.set(key, doc);
      batch.set(db.collection(CACHE).doc(key), doc);
    }
    await batch.commit();
  }

  // 3. Add it up per meal.
  const now = new Date().toISOString();
  const macros: Record<string, MealMacros> = {};
  meals.forEach((m, mi) => {
    const total: Macros = { calories: 0, protein: 0, carbs: 0, fat: 0, fiber: 0 };
    let matched = 0;
    let weighed = 0;
    let gramsAll = 0;
    let gramsMatched = 0;
    const ingredients: MealMacros["ingredients"] = [];
    flat.forEach((f, i) => {
      if (f.meal !== mi) return;
      const c = conv[i];
      const food = c.food ? foods.get(foodKey(c.food)) : undefined;
      const n = food?.per100g ?? null;
      if (c.grams !== null && c.food !== null) {
        weighed++;
        gramsAll += c.grams;
      }
      if (c.grams !== null && n) {
        matched++;
        gramsMatched += c.grams;
        for (const k of Object.keys(total) as (keyof Macros)[]) total[k] += (n[k] * c.grams) / 100;
      }
      ingredients.push({
        item: f.ing.item,
        amount: f.ing.amount,
        grams: c.grams === null ? null : Math.round(c.grams),
        food: food?.description ?? null,
        fdcId: food?.fdcId ?? null,
      });
    });
    const servings = Math.max(1, m.servings || 1);
    macros[m.name] = {
      perServing: {
        calories: Math.round(total.calories / servings),
        protein: round1(total.protein / servings),
        carbs: round1(total.carbs / servings),
        fat: round1(total.fat / servings),
        fiber: round1(total.fiber / servings),
      },
      servings,
      matched,
      ingredientCount: weighed,
      coverage: gramsAll > 0 ? Math.round((gramsMatched / gramsAll) * 100) / 100 : 0,
      ingredients,
      source: "USDA FoodData Central",
      version: MACROS_VERSION,
      computedAt: now,
    };
  });
  return { macros, inputTokens, outputTokens, lookups: missing.length };
}

/** The meals a plan's macros should cover: every idea when there are extras, else the meals. */
export function planMeals(plan: { meals?: Meal[]; options?: { meals?: Meal[] } }): Meal[] {
  return plan.options?.meals?.length ? plan.options.meals : plan.meals ?? [];
}

/** True when every meal in the plan already has macros from the current version. */
export function hasAllMacros(plan: { meals?: Meal[]; options?: { meals?: Meal[] }; mealMacros?: Record<string, MealMacros> }): boolean {
  const meals = planMeals(plan);
  return meals.length > 0 && meals.every((m) => plan.mealMacros?.[m.name]?.version === MACROS_VERSION);
}
