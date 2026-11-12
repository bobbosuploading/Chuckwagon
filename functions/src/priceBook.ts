/**
 * Price books: everyday (non-sale) shelf prices per store, used to price the parts of a
 * meal plan that aren't on sale.
 *
 *   priceBooks/{storeId}      written by a collector (Kroger API today). Replaced each run.
 *   receiptPrices/{storeId}   built from shoppers' scanned receipts. Merged, newest wins.
 *                             Sale prices are kept out of `price` (see receiptSales.ts).
 *
 * Both docs hold an `items` array of PriceBookItem, kept small enough for one Firestore
 * document (1 MB), so a meal plan needs only one or two reads per store.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { Category } from "./config";

export interface PriceBookItem {
  name: string;
  size: string | null;
  /** Everyday price. Per lb when soldBy is "WEIGHT". */
  price: number;
  /** Current promo price, if the item is on sale today. */
  promo?: number | null;
  /** Receipts only: what it sold for on sale on seenAt. History, not a current promo. */
  salePrice?: number | null;
  soldBy: "UNIT" | "WEIGHT";
  category: Category | null;
  source: "kroger-api" | "receipt" | "heb-apify" | "sams-apify";
  /** ISO date the price was seen. */
  seenAt: string;
}

export interface PriceBookDoc {
  storeId: string;
  chain: string;
  items: PriceBookItem[];
  updatedAt: string;
}

/**
 * Extra searches the Kroger collector runs only to fill the price book: everyday
 * ingredients that recipes need but that rarely show up in the deal searches.
 */
export const PRICE_BOOK_TERMS: Record<Category, string[]> = {
  produce: [
    "garlic", "cilantro", "limes", "lemons", "celery", "carrots", "broccoli", "spinach", "mushrooms",
    "green onions", "jalapeno", "avocado", "corn", "zucchini", "cucumber", "bananas", "cabbage", "ginger",
  ],
  dairy: ["sour cream", "shredded cheese", "heavy cream", "cream cheese", "parmesan"],
  pantry: [
    "chicken broth", "canned tomatoes", "tomato paste", "salsa", "soy sauce", "taco seasoning", "olive oil",
    "vegetable oil", "vinegar", "ketchup", "mayonnaise", "mustard", "sugar", "honey", "peanut butter",
    "bbq sauce", "spices", "breadcrumbs", "cornstarch", "noodles", "oats",
  ],
  bakery: ["hamburger buns", "hot dog buns"],
  frozen: ["frozen corn", "frozen peas"],
  meat: [],
  seafood: [],
  household: [],
};

/** Firestore caps documents at 1 MiB; leave room for field names and overhead. */
const MAX_DOC_BYTES = 900_000;

/** Trims a book to fit in one Firestore document, keeping the most recent items. */
export function fitToDoc(items: PriceBookItem[]): PriceBookItem[] {
  const sorted = [...items].sort((a, b) => b.seenAt.localeCompare(a.seenAt));
  let size = JSON.stringify(sorted).length;
  while (size > MAX_DOC_BYTES && sorted.length) {
    const drop = Math.max(1, Math.floor(sorted.length * 0.05));
    sorted.splice(sorted.length - drop, drop);
    size = JSON.stringify(sorted).length;
  }
  return sorted;
}

/** Lowercase words without punctuation, with simple plurals folded ("tomatoes" -> "tomato"). */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(oes|ies|es|s)$/, (m) => (m === "ies" ? "y" : m === "oes" ? "o" : m === "es" ? "e" : "")));
}
const STOP = new Set([
  "fresh", "large", "small", "medium", "the", "of", "and", "or", "for", "with", "to", "a", "an", "oz", "lb", "ct",
  "pack", "pk", "bag", "can", "jar", "bottle", "box", "count", "each", "about", "whole", "kroger", "heb", "store",
  "brand", "organic", "family", "size", "value",
]);

/**
 * Up to `limit` price book items that share the most words with `item`, ties broken
 * by lowest price. A shortlist for the model to pick from, not a final answer.
 */
export function shortlist(item: string, book: PriceBookItem[], limit = 8): PriceBookItem[] {
  const want = new Set(words(item));
  if (want.size === 0) return [];
  const scored: { p: PriceBookItem; score: number }[] = [];
  for (const p of book) {
    const have = new Set(words(p.name));
    let hits = 0;
    for (const w of want) if (have.has(w)) hits++;
    if (hits === 0) continue;
    // Favor names that are mostly about this item ("garlic" over "garlic bread croutons").
    const score = hits / want.size + hits / Math.max(have.size, 1) * 0.5;
    scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
  return scored.slice(0, limit).map((s) => s.p);
}

/** Loads the collector book and the receipt book for a store (either may be missing). */
export async function loadPriceBook(db: Firestore, storeId: string): Promise<PriceBookItem[]> {
  const [book, receipts] = await Promise.all([
    db.doc(`priceBooks/${storeId}`).get(),
    db.doc(`receiptPrices/${storeId}`).get(),
  ]);
  return [
    // A sale on an old receipt is long over, so receipt items never carry a promo.
    ...(((receipts.get("items") as PriceBookItem[] | undefined) ?? []).map((p) => ({ ...p, promo: null }))),
    ...(((book.get("items") as PriceBookItem[] | undefined) ?? [])),
  ];
}
