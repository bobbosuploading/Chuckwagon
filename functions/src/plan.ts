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

/** Change this to compare models. Must be a current Claude model ID. */
export const DEFAULT_MODEL = "claude-opus-5-5";

export interface PlanRequest {
  storeId: string;
  mealCount?: number; // default 4
  householdSize?: number; // default 3
  diet?: string; // e.g. "none", "vegetarian", "no pork"
  allergies?: string; // strict: never include
  dislikes?: string;
  haveAtHome?: string;
  maxCookMinutes?: number; // default 45
  budget?: number; // optional: total for sale + regular items, in dollars
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
      dealId: z.string().nullable(),
      forMeals: z.array(z.string()),
    })
  ),
  notes: z.string().describe("Short note to the shopper, or empty string"),
});
export type ModelPlan = z.infer<typeof PlanSchema>;

const SYSTEM = `You plan budget-friendly home meals from one grocery store's current sale items.

Rules:
- Build each meal mainly from the SALE ITEMS. Use non-sale items only where a meal truly needs them, and keep those cheap and common.
- Only cite sale items that are listed, by their exact id. Never invent a deal or a price.
- Allergies are absolute: never include an allergen, even as a minor ingredient. Respect diet and dislikes too.
- Leave anything under HAVE AT HOME off the grocery list, though meals may use it.
- Prefer meals that share ingredients so the list stays short and little goes to waste.
- Size quantities for the household and the number of meals. buyCount is whole packages or units as sold.
- Keep recipes to the time limit, written as short numbered-step instructions a busy parent can follow.
- If a BUDGET is given, keep the estimated total under it; pick cheaper meals if needed.
- If the sale items can't support the requested number of meals, return fewer and explain in notes.
- Group the grocery list by aisle, one line per item to buy.`;

function dealLine(d: Deal, id: string): string {
  const size = d.size ? ` | ${d.size}` : "";
  const per = d.soldBy === "WEIGHT" ? "/lb" : "";
  return `- id=${id} | ${d.name}${size} | sale $${d.salePrice.toFixed(2)}${per} | regular $${d.regularPrice.toFixed(2)}${per} | ${d.category}`;
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
  checked: boolean;
}

export interface MealPlan {
  storeId: string;
  storeName: string;
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
  model = DEFAULT_MODEL
): Promise<MealPlan> {
  const store = await db.doc(`stores/${req.storeId}`).get();
  if (!store.exists) throw new Error(`Unknown store ${req.storeId}`);

  // Pick the best deals (highest % off) per category.
  const deals = new Map<string, Deal>(); // short id -> deal
  for (const [category, limit] of Object.entries(DEALS_PER_CATEGORY)) {
    const snap = await db
      .collection("deals")
      .where("storeId", "==", req.storeId)
      .where("category", "==", category)
      .orderBy("pctOff", "desc")
      .limit(limit!)
      .get();
    snap.forEach((doc) => deals.set(`d${deals.size + 1}`, doc.data() as Deal));
  }
  if (deals.size === 0) throw new Error(`No current deals for ${req.storeId}`);

  const lines = [...deals.entries()].map(([id, d]) => dealLine(d, id)).join("\n");
  const user = `STORE: ${store.get("name")}
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
    betas: ["server-side-fallback-2026-07-01"],
    // If the model declines (very unlikely for recipes), the API retries on a fallback model.
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: user }],
  });

  if (response.stop_reason === "refusal") throw new Error("The model declined to make this plan");
  if (response.stop_reason === "max_tokens") throw new Error("The plan was cut off (max_tokens)");
  const plan = response.parsed_output;
  if (!plan) throw new Error("The model's answer didn't match the plan format");

  // Price the list from our own data.
  let saleItems = 0;
  let savings = 0;
  let itemsNotPriced = 0;
  const groceryList: PricedListItem[] = plan.groceryList.map((li) => {
    const deal = li.dealId ? deals.get(li.dealId) : undefined;
    if (!deal) {
      itemsNotPriced++;
      return { ...li, dealId: null, onSale: false, salePrice: null, regularPrice: null, lineTotal: null, lineSavings: null, checked: false };
    }
    // Weight-priced items have per-lb prices; we only know package counts, so leave the line total out.
    const byWeight = deal.soldBy === "WEIGHT";
    const lineTotal = byWeight ? null : round2(deal.salePrice * li.buyCount);
    const lineSavings = byWeight ? null : round2(deal.savings * li.buyCount);
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
      checked: false,
    };
  });

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
    storeName: store.get("name"),
    model: response.model,
    request: req,
    meals,
    groceryList,
    notes: plan.notes,
    totals: { saleItems: round2(saleItems), savings: round2(savings), itemsNotPriced },
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: price ? Math.round(((inputTokens * price[0] + outputTokens * price[1]) / 1e6) * 10000) / 10000 : null,
    },
    createdAt: new Date().toISOString(),
  };
}
