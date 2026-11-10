/**
 * Prices the grocery list items that aren't on sale, from the store's price book.
 *
 * A word-match shortlist finds candidate products, then one small Haiku call picks the
 * right product and how many to buy (the shortlist alone can't tell "garlic" from
 * "garlic bread"). Prices always come from our data; the model only picks.
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { Firestore } from "firebase-admin/firestore";
import { z } from "zod";
import { loadPriceBook, PriceBookItem, shortlist } from "./priceBook";

export const MATCH_MODEL = "claude-haiku-5-5";

export interface ItemToPrice {
  item: string;
  quantityNote: string;
  buyCount: number;
  storeId: string;
}

export interface ItemPrice {
  product: string;
  size: string | null;
  /** Price per package, or per lb when perLb. */
  unitPrice: number;
  perLb: boolean;
  /** Packages to buy, or pounds when perLb. */
  quantity: number;
  lineTotal: number;
  /** "store": this store's own prices. "receipt": a shopper's receipt from this store.
   *  "estimate": no price for this store, so a nearby store's price stands in. */
  source: "store" | "receipt" | "estimate";
}

const PickSchema = z.object({
  picks: z.array(
    z.object({
      item: z.number().int().describe("The ITEM number"),
      choice: z.string().nullable().describe("Letter of the matching product, or null if none fits"),
      quantity: z
        .number()
        .describe("Packages to buy; for a per-lb product, pounds to buy"),
    })
  ),
});

const SYSTEM = `You match grocery list items to store products so they can be priced.
For each ITEM, pick the product letter that a shopper would actually buy for it: the same food in a sensible
form and size, usually the cheapest plain or store-brand choice. Never pick a different food that merely
shares a word ("garlic" is not "garlic bread"; "chicken broth" is not "chicken"). Use null if nothing fits.
quantity: how many packages cover the NEED, or for a product priced per lb, the pounds to buy.`;

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function priceRegularItems(
  db: Firestore,
  anthropic: Anthropic,
  items: ItemToPrice[]
): Promise<{ prices: (ItemPrice | null)[]; inputTokens: number; outputTokens: number }> {
  const none = { prices: items.map(() => null), inputTokens: 0, outputTokens: 0 };
  if (items.length === 0) return none;

  // Each store's own prices (collector + receipts). For stores with no collector prices
  // (H-E-B, Aldi, Dollar General today), a Kroger price book stands in as an estimate.
  const books = new Map<string, { items: PriceBookItem[]; hasCollector: boolean }>();
  for (const id of new Set(items.map((i) => i.storeId))) {
    const all = await loadPriceBook(db, id);
    books.set(id, { items: all, hasCollector: all.some((p) => p.source !== "receipt") });
  }
  let fallback: PriceBookItem[] = [];
  if ([...books.values()].some((b) => !b.hasCollector)) {
    const any = await db.collection("priceBooks").limit(1).get();
    fallback = (any.docs[0]?.get("items") as PriceBookItem[] | undefined) ?? [];
  }

  const letters = "abcdefgh";
  const options: { candidates: PriceBookItem[]; estimate: boolean }[] = items.map((it) => {
    const book = books.get(it.storeId)!;
    const own = shortlist(it.item, book.items);
    if (own.length || book.hasCollector) return { candidates: own, estimate: false };
    return { candidates: shortlist(it.item, fallback), estimate: true };
  });
  if (options.every((o) => o.candidates.length === 0)) return none;

  const lines: string[] = [];
  items.forEach((it, i) => {
    const c = options[i].candidates;
    if (!c.length) return;
    lines.push(`ITEM ${i + 1}: ${it.item} | NEED: ${it.quantityNote} (planner said buy ${it.buyCount})`);
    c.forEach((p, j) => {
      const per = p.soldBy === "WEIGHT" ? "per lb" : "each";
      lines.push(`  ${letters[j]}) ${p.name}${p.size ? ` | ${p.size}` : ""} | $${(p.promo ?? p.price).toFixed(2)} ${per}`);
    });
  });

  const response = await anthropic.beta.messages.parse({
    model: MATCH_MODEL,
    max_tokens: 4000,
    output_config: { format: betaZodOutputFormat(PickSchema) },
    system: SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
  });
  const parsed = response.parsed_output;
  const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  if (!parsed) return { ...none, ...usage };

  const prices: (ItemPrice | null)[] = items.map(() => null);
  for (const pick of parsed.picks) {
    const i = pick.item - 1;
    const opt = options[i];
    if (!opt || !pick.choice) continue;
    const p = opt.candidates[letters.indexOf(pick.choice.trim().toLowerCase())];
    if (!p) continue;
    const perLb = p.soldBy === "WEIGHT";
    // Guard against silly quantities: at least one package, at most 20 (or 0.25 to 20 lb).
    const quantity = perLb
      ? Math.min(Math.max(round2(pick.quantity), 0.25), 20)
      : Math.min(Math.max(Math.round(pick.quantity), 1), 20);
    const unitPrice = p.promo ?? p.price;
    prices[i] = {
      product: p.name,
      size: p.size,
      unitPrice,
      perLb,
      quantity,
      lineTotal: round2(unitPrice * quantity),
      source: opt.estimate ? "estimate" : p.source === "receipt" ? "receipt" : "store",
    };
  }
  return { prices, ...usage };
}
