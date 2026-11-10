/**
 * Tells sale prices apart from everyday prices on a scanned receipt, so a week's sale
 * (say, $3 bacon) doesn't become the store's "everyday" price. No AI: the receipt read
 * already gives us the discount lines; the rest is comparing against what we know.
 *
 * A line is a sale when any of these hold:
 *   "receipt"     the receipt shows it: a coupon or discount line under the item, a printed
 *                 regular price above what was paid, or a sale mark ("SALE", "YOU SAVED").
 *   "ad"          what was paid matches this week's ad price for the item at this store.
 *   "below-usual" what was paid is well under the regular price we already know (the store's
 *                 price book or earlier receipts).
 */
import { PriceBookItem, words } from "./priceBook";

/** One product line as read from the receipt. */
export interface ReceiptLine {
  name: string;
  size: string | null;
  quantity: number;
  pounds: number | null;
  /** Price printed on the product line, before any separate coupon/discount lines. */
  linePrice: number;
  /** Total of coupon/discount lines that apply to this product (positive), if any. */
  discount: number | null;
  /** Regular unit price if the receipt prints it. */
  regularPrice: number | null;
  /** The receipt marks the line as a sale or price cut. */
  markedSale: boolean;
}

/** The bits of an ad deal needed to match a receipt line. */
export interface AdPrice {
  name: string;
  size: string | null;
  soldBy: string | null;
  salePrice: number | null;
  regularPrice: number | null;
}

export type SaleReason = "receipt" | "ad" | "below-usual";

export interface SaleCheck {
  soldBy: "UNIT" | "WEIGHT";
  /** What the shopper paid per unit (per lb for weighed items), after discounts. */
  paid: number;
  /** Best known everyday price per unit (per lb), or null if we don't know it. */
  regular: number | null;
  sale: SaleReason | null;
}

/** Paid at or under this share of the known regular price counts as a sale. */
export const BELOW_USUAL = 0.8;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "32 OZ", "32oz", "32 ounce" -> "32oz". */
function normSize(size: string | null | undefined): string | null {
  if (!size) return null;
  const s = size
    .toLowerCase()
    .replace(/ounces?/g, "oz")
    .replace(/pounds?|lbs/g, "lb")
    .replace(/counts?|ct\b/g, "ct")
    .replace(/[^a-z0-9.]/g, "");
  return s || null;
}

/** Words with "-ed" endings and filler folded, so "smoked" meets "smoke". */
const FILLER = new Set(["flavor", "flavored", "style", "original", "classic", "brand", "on"]);
function stems(text: string): Set<string> {
  return new Set(words(text).filter((w) => !FILLER.has(w)).map((w) => (w.length > 4 ? w.replace(/ed$/, "") : w)));
}

/**
 * How well two product names match (0 when they shouldn't be treated as the same item).
 * Most of the receipt name's words must appear in the other name, and the other name
 * must be mostly about this item ("bacon" vs "bacon bits" is fine, "bacon cheeseburger
 * kit" is not).
 */
export function matchScore(a: string, aSize: string | null, b: string, bSize: string | null): number {
  const sa = normSize(aSize);
  const sb = normSize(bSize);
  if (sa && sb && sa !== sb) return 0;
  const want = stems(a);
  const have = stems(b);
  if (want.size === 0 || have.size === 0) return 0;
  let hits = 0;
  for (const w of want) if (have.has(w)) hits++;
  if (hits === 0 || (want.size >= 2 && have.size >= 2 && hits < 2)) return 0;
  const cover = hits / want.size;
  const focus = hits / have.size;
  if (cover < 0.5 || focus < 0.6) return 0;
  return cover + focus * 0.5 + (sa && sa === sb ? 0.25 : 0);
}

function best<T extends { name: string; size: string | null }>(line: { name: string; size: string | null }, list: T[]): T | null {
  let top: T | null = null;
  let topScore = 0;
  for (const c of list) {
    const s = matchScore(line.name, line.size, c.name, c.size);
    if (s > topScore) {
      top = c;
      topScore = s;
    }
  }
  return top;
}

/**
 * Works out what was paid, the everyday price if we can tell, and whether it was a sale.
 * `book` is the store's known everyday prices; `ads` is this week's ad for the store
 * (pass [] when the receipt isn't from this week).
 */
export function checkLine(line: ReceiptLine, book: PriceBookItem[], ads: AdPrice[]): SaleCheck {
  const byWeight = line.pounds !== null && line.pounds > 0;
  const soldBy = byWeight ? "WEIGHT" : "UNIT";
  const units = byWeight ? line.pounds! : Math.max(line.quantity || 1, 1);
  const discount = Math.min(Math.max(line.discount ?? 0, 0), line.linePrice);
  const paid = round2((line.linePrice - discount) / units);
  const shelf = round2(line.linePrice / units);

  // 1. The receipt says so.
  if (discount > 0.009) return { soldBy, paid, regular: line.regularPrice && line.regularPrice > shelf ? line.regularPrice : shelf, sale: "receipt" };
  if (line.regularPrice && line.regularPrice > paid + 0.009) return { soldBy, paid, regular: line.regularPrice, sale: "receipt" };

  const known = best(line, book.filter((p) => p.soldBy === soldBy && p.price > 0));
  const knownRegular = known ? known.price : null;
  if (line.markedSale) return { soldBy, paid, regular: knownRegular && knownRegular > paid ? knownRegular : null, sale: "receipt" };

  // 2. It's this week's ad price.
  const ad = best(
    line,
    ads.filter((d) => d.salePrice && d.salePrice > 0 && (d.soldBy === "WEIGHT") === byWeight)
  );
  if (ad && Math.abs(ad.salePrice! - paid) <= Math.max(0.05, paid * 0.03)) {
    const regular = ad.regularPrice && ad.regularPrice > paid ? ad.regularPrice : knownRegular && knownRegular > paid ? knownRegular : null;
    return { soldBy, paid, regular, sale: "ad" };
  }

  // 3. Well under the usual price.
  if (knownRegular && paid <= knownRegular * BELOW_USUAL) return { soldBy, paid, regular: knownRegular, sale: "below-usual" };

  return { soldBy, paid, regular: paid, sale: null };
}
