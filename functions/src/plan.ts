/**
 * "Headed to [store]": turns one store's current deals into meals and a grocery list.
 *
 * The model picks meals and quantities and cites deals by ID. All prices and savings
 * are filled in here from Firestore, so the math never depends on the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { Category } from "./config";
import type { Deal } from "./collectKroger";
import { StockUp, stockUpTip } from "./stockUp";

/** Everyday plans use Haiku (about half a cent each); premium plans use Opus (about 17 cents). */
export const DEFAULT_MODEL = "claude-haiku-5-5";
export const PREMIUM_MODEL = "claude-opus-5-5";
/** Models that support the server-side refusal fallback. */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-sonnet-5-5"]);

export interface PlanRequest {
  storeId: string; // the main store
  /** Optional: plan across several stores (up to 3). Each item is bought where it's on sale. */
  storeIds?: string[];
  mealCount?: number; // default 4
  householdSize?: number; // default 3
  diet?: string; // e.g. "none", "vegetarian", "no pork"
  allergies?: string; // strict: never include
  dislikes?: string;
  haveAtHome?: string;
  maxCookMinutes?: number; // default 45
  budget?: number; // optional: total for sale + regular items, in dollars
  premium?: boolean; // use PREMIUM_MODEL ("chef's pick")
}

/** How many of the best deals per category to send to the model. Household goods aren't meal ingredients. */
const DEALS_PER_CATEGORY: Partial<Record<Category, number>> = {
  meat: 40,
  seafood: 15,
  produce: 30,
  dairy: 20,
  bakery: 10,
  pantry: 30,
  frozen: 15,
};

const AISLES = ["Produce", "Meat", "Seafood", "Dairy", "Bakery", "Frozen", "Pantry", "Other"] as const;
const CATEGORY_AISLE: Partial<Record<Category, (typeof AISLES)[number]>> = {
  produce: "Produce",
  meat: "Meat",
  seafood: "Seafood",
  dairy: "Dairy",
  bakery: "Bakery",
  frozen: "Frozen",
  pantry: "Pantry",
};

const PlanSchema = z.object({
  meals: z.array(
    z.object({
      name: z.string(),
      servings: z.number().int(),
      timeMinutes: z.number().int(),
      ingredients: z.array(
        z.object({
          item: z.string(),
          amount: z.string(),
          dealId: z.string().nullable().describe("ID from SALE ITEMS, or null if not on sale"),
        })
      ),
      steps: z.array(z.string()),
    })
  ),
  groceryList: z.array(
    z.object({
      aisle: z.enum(AISLES),
      item: z.string(),
      buyCount: z.number().int().describe("How many packages/units of this item to buy"),
      quantityNote: z.string().describe('Human-friendly amount, e.g. "about 3 lb" or "1 bag"'),
      pounds: z
        .number()
        .nullable()
        .describe("For sale items priced per lb (/lb): estimated pounds to buy in total. Otherwise null."),
      dealId: z.string().nullable(),
      forMeals: z.array(z.string()),
    })
  ),
  notes: z.string().describe("Short note to the shopper, or empty string"),
});
export type ModelPlan = z.infer<typeof PlanSchema>;

const SYSTEM = `You plan budget-friendly home meals from current grocery sale items, at one store or a few.

Rules:
- Build each meal mainly from the SALE ITEMS. Use non-sale items only where a meal truly needs them, and keep those cheap and common.
- Only cite sale items that are listed, by their exact id. Never invent a deal or a price.
- If SALE ITEMS come from more than one store, mix them freely, but don't send the shopper to an extra store for only one or two small savings.
- Some sale items list a "deal" (such as buy 2, get 1 free) instead of a price; use them when the deal fits the meals.
- Allergies are absolute: never include an allergen, even as a minor ingredient. Respect diet and dislikes too.
- A diet applies to the whole dish, including sauces, marinades and glazes (for example, sugary BBQ or teriyaki sauces are not low carb).
- Make each meal a real recipe with varied flavors; don't repeat the same main vegetable or sauce in most meals.
- Leave anything under HAVE AT HOME off the grocery list, though meals may use it.
- Prefer meals that share ingredients so the list stays short and little goes to waste.
- Size quantities for the household and the number of meals. buyCount is whole packages or units as sold.
- Keep recipes to the time limit, written as short numbered-step instructions a busy parent can follow.
- If a BUDGET is given, keep the estimated total under it; pick cheaper meals if needed.
- If the sale items can't support the requested number of meals, return fewer and explain in notes.
- The grocery list must be COMPLETE: every ingredient from every meal that isn't under HAVE AT HOME, combined into one line per product (usually 12 to 25 lines). Group it by aisle.`;

function dealLine(d: Deal, id: string, storeName?: string): string {
  const size = d.size ? ` | ${d.size}` : "";
  const per = d.soldBy === "WEIGHT" ? "/lb" : "";
  const sale = d.salePrice !== null ? ` | sale $${d.salePrice.toFixed(2)}${per}` : "";
  const regular = d.regularPrice !== null ? ` | regular $${d.regularPrice.toFixed(2)}${per}` : "";
  const promo = d.promo ? ` | deal: ${d.promo.slice(0, 160)}` : "";
  const at = storeName ? ` | at ${storeName}` : "";
  return `- id=${id} | ${d.name}${size}${sale}${regular}${promo} | ${d.category}${at}`;
}

export interface PricedListItem {
  aisle: string;
  item: string;
  buyCount: number;
  quantityNote: string;
  dealId: string | null;
  onSale: boolean;
  salePrice: number | null;
  regularPrice: number | null;
  lineTotal: number | null;
  lineSavings: number | null;
  forMeals: string[];
  /** Where to buy it. Non-sale items go to the store with the most items. */
  storeId: string;
  storeName: string;
  /** Set when the sale price is worth buying extra of and the item keeps. */
  stockUp: StockUp | null;
  checked: boolean;
}

export interface StoreTotal {
  storeId: string;
  storeName: string;
  items: number;
  saleItems: number;
  savings: number;
}

export interface MealPlan {
  storeId: string;
  storeName: string;
  storeIds: string[];
  /** Per-store totals, in the order the shopper should visit (most items first). */
  stores: StoreTotal[];
  model: string;
  request: PlanRequest;
  meals: ModelPlan["meals"];
  groceryList: PricedListItem[];
  notes: string;
  totals: { saleItems: number; savings: number; itemsNotPriced: number };
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number | null };
  createdAt: string;
}

/** USD per million tokens (input, output), from Anthropic's price list. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function planMeals(
  db: Firestore,
  anthropic: Anthropic,
  req: PlanRequest,
  modelOverride?: string
): Promise<MealPlan> {
  const model = modelOverride || (req.premium ? PREMIUM_MODEL : DEFAULT_MODEL);
  const storeIds = [...new Set([req.storeId, ...(req.storeIds ?? [])])].slice(0, 3);
  const storeNames = new Map<string, string>();
  for (const id of storeIds) {
    const doc = await db.doc(`stores/${id}`).get();
    if (!doc.exists) throw new Error(`Unknown store ${id}`);
    storeNames.set(id, doc.get("name"));
  }
  const multi = storeIds.length > 1;

  // Pick the best deals (highest % off) per category, sharing the budget across stores.
  const deals = new Map<string, Deal>(); // short id -> deal
  for (const id of storeIds) {
    for (const [category, limit] of Object.entries(DEALS_PER_CATEGORY)) {
      const snap = await db
        .collection("deals")
        .where("storeId", "==", id)
        .where("category", "==", category)
        .orderBy("pctOff", "desc")
        .limit(Math.ceil(limit! / storeIds.length))
        .get();
      snap.forEach((doc) => deals.set(`d${deals.size + 1}`, doc.data() as Deal));
    }
  }
  if (deals.size === 0) throw new Error(`No current deals for ${storeIds.join(", ")}`);

  const lines = [...deals.entries()]
    .map(([id, d]) => dealLine(d, id, multi ? storeNames.get(d.storeId) : undefined))
    .join("\n");
  const user = `${multi ? "STORES" : "STORE"}: ${storeIds.map((id) => storeNames.get(id)).join(", ")}
HOUSEHOLD SIZE: ${req.householdSize ?? 3}
NUMBER OF MEALS: ${req.mealCount ?? 4}
MAX COOK TIME: ${req.maxCookMinutes ?? 45} minutes
DIET: ${req.diet || "none"}
ALLERGIES: ${req.allergies || "none"}
DISLIKES: ${req.dislikes || "none"}
HAVE AT HOME: ${req.haveAtHome || "salt, pepper, cooking oil, basic spices"}
BUDGET: ${req.budget ? `$${req.budget}` : "none"}

SALE ITEMS:
${lines}`;

  const response = await anthropic.beta.messages.parse({
    model,
    max_tokens: 16000,
    // If the model declines (very unlikely for recipes), the API retries on a fallback model.
    ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
    output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined to make this plan");
  if (response.stop_reason === "max_tokens") throw new Error("The plan was cut off (max_tokens)");
  const plan = response.parsed_output;
  if (!plan) throw new Error("The model's answer didn't match the plan format");

  // Safety net: if the model left meal ingredients off the list, add them.
  const listed = plan.groceryList;
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const listedDealIds = new Set(listed.map((li) => li.dealId).filter(Boolean));
  const listedNames = new Set(listed.map((li) => norm(li.item)));
  const atHome = (req.haveAtHome || "salt, pepper, cooking oil, oil, basic spices, spices")
    .split(",")
    .map(norm)
    .filter(Boolean);
  const missing = new Map<string, ModelPlan["groceryList"][number]>();
  for (const meal of plan.meals) {
    for (const ing of meal.ingredients) {
      const deal = ing.dealId ? deals.get(ing.dealId) : undefined;
      const key = deal ? `deal:${ing.dealId}` : `name:${norm(ing.item)}`;
      if (deal && listedDealIds.has(ing.dealId)) continue;
      if (!deal && (listedNames.has(norm(ing.item)) || atHome.some((h) => norm(ing.item).includes(h)))) continue;
      const existing = missing.get(key);
      if (existing) {
        existing.quantityNote += ` + ${ing.amount}`;
        if (!existing.forMeals.includes(meal.name)) existing.forMeals.push(meal.name);
        continue;
      }
      missing.set(key, {
        aisle: deal ? CATEGORY_AISLE[deal.category] ?? "Other" : "Other",
        item: deal ? deal.name : ing.item,
        buyCount: 1,
        quantityNote: ing.amount,
        pounds: null,
        dealId: deal ? ing.dealId : null,
        forMeals: [meal.name],
      });
    }
  }
  plan.groceryList = [...listed, ...missing.values()];

  // Price the list from our own data.
  let saleItems = 0;
  let savings = 0;
  let itemsNotPriced = 0;
  // Non-sale items go to the store where most sale items are bought.
  const saleCount = new Map<string, number>();
  for (const li of plan.groceryList) {
    const d = li.dealId ? deals.get(li.dealId) : undefined;
    if (d) saleCount.set(d.storeId, (saleCount.get(d.storeId) ?? 0) + 1);
  }
  const mainStore = [...saleCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? req.storeId;
  const groceryList: PricedListItem[] = plan.groceryList.map((li) => {
    const deal = li.dealId ? deals.get(li.dealId) : undefined;
    if (!deal) {
      itemsNotPriced++;
      return {
        ...li, dealId: null, onSale: false, salePrice: null, regularPrice: null, lineTotal: null, lineSavings: null,
        storeId: mainStore, storeName: storeNames.get(mainStore)!, stockUp: null, checked: false,
      };
    }
    // Weight-priced items have per-lb prices, so multiply by the estimated pounds instead of the package count.
    const byWeight = deal.soldBy === "WEIGHT";
    const qty = byWeight ? li.pounds : li.buyCount;
    const lineTotal = qty && deal.salePrice !== null ? round2(deal.salePrice * qty) : null;
    const lineSavings = qty && deal.savings !== null ? round2(deal.savings * qty) : null;
    if (lineTotal === null) itemsNotPriced++;
    if (lineTotal !== null) saleItems += lineTotal;
    if (lineSavings !== null) savings += lineSavings;
    return {
      ...li,
      dealId: `${deal.storeId}_${deal.productId}`,
      onSale: true,
      salePrice: deal.salePrice,
      regularPrice: deal.regularPrice,
      lineTotal,
      lineSavings,
      storeId: deal.storeId,
      storeName: storeNames.get(deal.storeId)!,
      // Worked out here too, so plans get tips even for deals saved before tips existed.
      stockUp: deal.stockUp ?? stockUpTip(deal),
      checked: false,
    };
  });

  // Totals per store, busiest store first.
  const stores: StoreTotal[] = storeIds
    .map((id) => {
      const items = groceryList.filter((li) => li.storeId === id);
      return {
        storeId: id,
        storeName: storeNames.get(id)!,
        items: items.length,
        saleItems: round2(items.reduce((t, li) => t + (li.lineTotal ?? 0), 0)),
        savings: round2(items.reduce((t, li) => t + (li.lineSavings ?? 0), 0)),
      };
    })
    .filter((s) => s.items > 0)
    .sort((a, b) => b.items - a.items);
  let notes = plan.notes;
  for (const extra of stores.slice(1)) {
    if (extra.items <= 2 && extra.savings < 3) {
      notes += `${notes ? " " : ""}Tip: ${extra.storeName} only saves you ${extra.savings > 0 ? `$${extra.savings.toFixed(2)}` : "a little"} on ${extra.items} item${extra.items === 1 ? "" : "s"}. You could skip that stop and buy ${extra.items === 1 ? "it" : "them"} at ${stores[0].storeName}.`;
    }
  }

  const stockUps = groceryList.filter((li) => li.stockUp);
  if (stockUps.length > 0) {
    const names = stockUps.slice(0, 3).map((li) => li.item.toLowerCase());
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
    notes += `${notes ? " " : ""}Stock-up pick${stockUps.length === 1 ? "" : "s"}: ${list} ${stockUps.length === 1 ? "is" : "are"} priced low enough to buy extra and put away. See the tip on the list for how to keep ${stockUps.length === 1 ? "it" : "them"}.`;
  }

  // Map short deal ids in ingredients back to Firestore ids.
  const meals = plan.meals.map((m) => ({
    ...m,
    ingredients: m.ingredients.map((ing) => {
      const deal = ing.dealId ? deals.get(ing.dealId) : undefined;
      return { ...ing, dealId: deal ? `${deal.storeId}_${deal.productId}` : null };
    }),
  }));

  const price = PRICES[response.model] ?? PRICES[model];
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    storeId: req.storeId,
    storeName: storeIds.map((id) => storeNames.get(id)).join(" + "),
    storeIds,
    stores,
    model: response.model,
    // Firestore rejects undefined values, so drop unset options.
    request: JSON.parse(JSON.stringify(req)) as PlanRequest,
    meals,
    groceryList,
    notes,
    totals: { saleItems: round2(saleItems), savings: round2(savings), itemsNotPriced },
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: price ? Math.round(((inputTokens * price[0] + outputTokens * price[1]) / 1e6) * 10000) / 10000 : null,
    },
    createdAt: new Date().toISOString(),
  };
}
