/**
 * "Headed to [store]": turns one store's current deals into meals and a grocery list.
 *
 * The model picks meals and quantities and cites deals by ID. All prices and savings
 * are filled in here from Firestore, so the math never depends on the model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Firestore } from "firebase-admin/firestore";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { z } from "zod";
import type { Category } from "./config";
import type { Deal } from "./collectKroger";
import { MATCH_MODEL, priceRegularItems } from "./priceItems";

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
  /** Optional weekly budget in dollars for the whole list (sale + everyday items). The plan is built to fit it. */
  budget?: number;
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
      estimatedPrice: z
        .number()
        .describe("Your best guess of what this whole line costs in dollars: sale price x count for sale items, a typical everyday shelf price otherwise"),
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
- If a BUDGET is given, it comes first: the whole grocery list, sale and non-sale items together, must fit under it. To get there, lean on the cheapest proteins per serving (chicken thighs or leg quarters, whole chickens, ground meat, pork shoulder, eggs, beans), stretch meals with rice, pasta, potatoes and tortillas, reuse ingredients across meals, and buy only the packages the meals need. Make fewer meals only as a last resort, and say so in notes.
- Give every grocery line an estimatedPrice, and when there is a BUDGET keep their sum under its target.
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
  /** For items not on sale: where the price came from ("store", "receipt", or "estimate"
   *  when we have no prices for this store and a nearby store's price stands in). */
  priceSource?: "store" | "receipt" | "estimate" | null;
  /** For items not on sale: the product that was priced, e.g. "Kroger Garlic | 3 ct". */
  pricedAs?: string | null;
  /** Where to buy it. Non-sale items go to the store with the most items. */
  storeId: string;
  storeName: string;
  checked: boolean;
}

export interface StoreTotal {
  storeId: string;
  storeName: string;
  items: number;
  saleItems: number;
  savings: number;
  /** Everything priced at this store, sale and regular. */
  total: number;
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
  totals: {
    saleItems: number;
    savings: number;
    itemsNotPriced: number;
    /** Items not on sale, at everyday prices. */
    regularItems: number;
    /** saleItems + regularItems. Items we couldn't price are not included. */
    estimatedTotal: number;
    /** estimatedTotal / total servings across the meals. */
    perServing: number | null;
  };
  /** Only when the shopper set a budget. */
  budget?: {
    amount: number;
    /** amount - estimatedTotal; negative when over. */
    left: number;
    fits: boolean;
    /** True when the first plan was over budget and the model trimmed it. */
    revised: boolean;
  };
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

/** The model aims a little under the budget, because everyday prices are partly estimates. */
const BUDGET_AIM = 0.9;
/** Budgets outside this range are ignored (a typo, or not really a grocery budget). */
export const BUDGET_RANGE = { min: 10, max: 2000 };

/** One planning attempt after pricing: the model's plan with our prices filled in. */
interface PricedDraft {
  plan: ModelPlan;
  groceryList: PricedListItem[];
  saleItems: number;
  savings: number;
  itemsNotPriced: number;
  regularItems: number;
  estimatedTotal: number;
  model: string;
}

/** What the model hears when its plan came in over budget. */
function overBudgetFeedback(d: PricedDraft, budget: number): string {
  const priciest = d.groceryList
    .filter((li) => li.lineTotal !== null)
    .sort((a, b) => (b.lineTotal ?? 0) - (a.lineTotal ?? 0))
    .slice(0, 6)
    .map((li) => `- ${li.item} (buy ${li.buyCount}): $${li.lineTotal!.toFixed(2)}${li.onSale ? " on sale" : ""}`)
    .join("\n");
  return `With real store prices, that list comes to about $${d.estimatedTotal.toFixed(2)} (sale items $${d.saleItems.toFixed(2)}, everyday items $${d.regularItems.toFixed(2)}${d.itemsNotPriced ? `, plus ${d.itemsNotPriced} items we couldn't price` : ""}). That is $${(d.estimatedTotal - budget).toFixed(2)} over the $${budget} budget.

The priciest lines:
${priciest}

Make a new plan that fits. Aim for $${Math.floor(budget * BUDGET_AIM * 0.95)} or less: swap pricey proteins for cheaper ones, cut extra packages, share more ingredients between meals, and drop a meal only if nothing else works. Return the complete plan again.`;
}

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
  const budget =
    req.budget && req.budget >= BUDGET_RANGE.min && req.budget <= BUDGET_RANGE.max ? round2(req.budget) : undefined;

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
BUDGET: ${budget ? `$${budget} for the whole list (aim for about $${Math.floor(budget * BUDGET_AIM)} to leave room for price surprises)` : "none"}

SALE ITEMS:
${lines}`;

  // Token use across every call, split by model so the cost estimate stays right.
  const tokens = new Map<string, { input: number; output: number }>();
  const addTokens = (m: string, input: number, output: number) => {
    const t = tokens.get(m) ?? { input: 0, output: 0 };
    tokens.set(m, { input: t.input + input, output: t.output + output });
  };

  /** Asks the model for a plan, then prices its list from our own data. */
  const draft = async (messages: BetaMessageParam[]): Promise<PricedDraft> => {
    const response = await anthropic.beta.messages.parse({
      model,
      max_tokens: 16000,
      // If the model declines (very unlikely for recipes), the API retries on a fallback model.
      ...(FALLBACK_MODELS.has(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: { effort: "medium", format: betaZodOutputFormat(PlanSchema) },
      system: SYSTEM,
      messages,
    });
    addTokens(response.model, response.usage.input_tokens, response.usage.output_tokens);

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
          estimatedPrice: deal?.salePrice ?? 0,
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
    // estimatedPrice is only the model's own budget math; real prices come from our data below.
    const groceryList: PricedListItem[] = plan.groceryList.map(({ estimatedPrice: _guess, ...li }) => {
      const deal = li.dealId ? deals.get(li.dealId) : undefined;
      if (!deal) {
        return {
          ...li, dealId: null, onSale: false, salePrice: null, regularPrice: null, lineTotal: null, lineSavings: null,
          priceSource: null, pricedAs: null, storeId: mainStore, storeName: storeNames.get(mainStore)!, checked: false,
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
        checked: false,
      };
    });

    // Price the items that aren't on sale from each store's everyday prices.
    const regular = groceryList.filter((li) => !li.onSale);
    const matched = await priceRegularItems(
      db,
      anthropic,
      regular.map((li) => ({ item: li.item, quantityNote: li.quantityNote, buyCount: li.buyCount, storeId: li.storeId }))
    ).catch((err) => {
      // Pricing regular items is a bonus; never fail the plan over it.
      console.warn("Regular-price matching failed", err);
      return { prices: regular.map(() => null), inputTokens: 0, outputTokens: 0 };
    });
    addTokens(MATCH_MODEL, matched.inputTokens, matched.outputTokens);
    let regularItems = 0;
    regular.forEach((li, i) => {
      const p = matched.prices[i];
      if (!p) {
        itemsNotPriced++;
        return;
      }
      li.regularPrice = p.unitPrice;
      li.lineTotal = p.lineTotal;
      li.priceSource = p.source;
      const qty = p.perLb ? ` | ${p.quantity} lb` : p.quantity > 1 ? ` | x${p.quantity}` : "";
      li.pricedAs = `${p.product}${p.size ? ` | ${p.size}` : ""}${qty}`;
      regularItems += p.lineTotal;
    });
    regularItems = round2(regularItems);
    const estimatedTotal = round2(saleItems + regularItems);
    return {
      plan, groceryList, saleItems: round2(saleItems), savings: round2(savings), itemsNotPriced, regularItems,
      estimatedTotal, model: response.model,
    };
  };

  // Budget-first: if the priced list comes in over budget, show the model the real
  // numbers and ask once for a cheaper plan. Keep whichever plan is cheaper.
  const messages: BetaMessageParam[] = [{ role: "user", content: user }];
  const first = await draft(messages);
  let chosen = first;
  let revised = false;
  if (budget && first.estimatedTotal > budget) {
    try {
      const second = await draft([
        ...messages,
        { role: "assistant", content: JSON.stringify(first.plan) },
        { role: "user", content: overBudgetFeedback(first, budget) },
      ]);
      if (second.estimatedTotal < first.estimatedTotal && second.plan.meals.length > 0) {
        chosen = second;
        revised = true;
      }
    } catch (err) {
      // The first plan is still good to show; just note it's over.
      console.warn("Budget revision failed", err);
    }
  }
  const { plan, groceryList, saleItems, savings, itemsNotPriced, regularItems, estimatedTotal } = chosen;

  // Totals per store, busiest store first.
  const stores: StoreTotal[] = storeIds
    .map((id) => {
      const items = groceryList.filter((li) => li.storeId === id);
      return {
        storeId: id,
        storeName: storeNames.get(id)!,
        items: items.length,
        saleItems: round2(items.reduce((t, li) => t + (li.onSale ? li.lineTotal ?? 0 : 0), 0)),
        savings: round2(items.reduce((t, li) => t + (li.lineSavings ?? 0), 0)),
        total: round2(items.reduce((t, li) => t + (li.lineTotal ?? 0), 0)),
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

  // Map short deal ids in ingredients back to Firestore ids.
  const meals = plan.meals.map((m) => ({
    ...m,
    ingredients: m.ingredients.map((ing) => {
      const deal = ing.dealId ? deals.get(ing.dealId) : undefined;
      return { ...ing, dealId: deal ? `${deal.storeId}_${deal.productId}` : null };
    }),
  }));

  if (budget && estimatedTotal > budget) {
    notes += `${notes ? " " : ""}Heads up: this week's list comes to about $${estimatedTotal.toFixed(2)}, $${(estimatedTotal - budget).toFixed(2)} over your $${budget} budget. Try fewer meals, or tell us what you already have at home.`;
  } else if (budget && itemsNotPriced > 0) {
    notes += `${notes ? " " : ""}${itemsNotPriced} item${itemsNotPriced === 1 ? " doesn't" : "s don't"} have a price yet, so leave a little room in your budget.`;
  }
  const servings = plan.meals.reduce((t, m) => t + m.servings, 0);

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | null = 0;
  for (const [m, t] of tokens) {
    inputTokens += t.input;
    outputTokens += t.output;
    const p = PRICES[m] ?? (m === chosen.model ? PRICES[model] : undefined);
    costUsd = p && costUsd !== null ? costUsd + (t.input * p[0] + t.output * p[1]) / 1e6 : null;
  }

  return {
    storeId: req.storeId,
    storeName: storeIds.map((id) => storeNames.get(id)).join(" + "),
    storeIds,
    stores,
    model: chosen.model,
    // Firestore rejects undefined values, so drop unset options.
    request: JSON.parse(JSON.stringify(req)) as PlanRequest,
    meals,
    groceryList,
    notes,
    totals: {
      saleItems,
      savings,
      itemsNotPriced,
      regularItems,
      estimatedTotal,
      perServing: servings > 0 ? round2(estimatedTotal / servings) : null,
    },
    ...(budget
      ? {
          budget: {
            amount: budget,
            left: round2(budget - estimatedTotal),
            fits: estimatedTotal <= budget,
            revised,
          },
        }
      : {}),
    usage: {
      inputTokens,
      outputTokens,
      estimatedCostUsd: costUsd !== null ? Math.round(costUsd * 10000) / 10000 : null,
    },
    createdAt: new Date().toISOString(),
  };
}
