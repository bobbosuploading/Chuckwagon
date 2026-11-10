/**
 * Receipt scanning: a shopper photographs a receipt, Claude reads the lines, and the
 * everyday prices go into receiptPrices/{storeId}. This is how we learn shelf prices
 * for stores with no API (H-E-B, ALDI, Dollar General), using data shoppers give us.
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { fitToDoc, loadPriceBook, PriceBookItem, words } from "./priceBook";
import { AdPrice, checkLine, SaleReason } from "./receiptSales";

export const RECEIPT_MODEL = "claude-haiku-5-5";

const ReceiptSchema = z.object({
  isReceipt: z.boolean().describe("False if the image is not a grocery store receipt"),
  storeName: z.string().nullable(),
  date: z.string().nullable().describe("Purchase date as YYYY-MM-DD, if printed"),
  items: z.array(
    z.object({
      name: z.string().describe("Plain product name with abbreviations spelled out, e.g. 'H-E-B ground beef 80/20'"),
      receiptText: z.string().describe("The line exactly as printed"),
      size: z.string().nullable().describe("Package size if printed, e.g. '16 oz'"),
      quantity: z.number().describe("Units bought (1 if not shown). For weighed items, 1."),
      pounds: z.number().nullable().describe("For weighed items: pounds bought. Otherwise null."),
      linePrice: z.number().describe("Price printed on the product line, before any separate coupon or discount lines"),
      discount: z
        .number()
        .nullable()
        .describe("Total of the coupon/discount/savings lines that apply to this product, as a positive number (e.g. 1.50). Null if none."),
      regularPrice: z.number().nullable().describe("Regular unit price if the receipt shows it (e.g. 'reg 3.49'), else null"),
      markedSale: z
        .boolean()
        .describe("True only if the receipt marks this line as a sale, special, price cut or savings. Not because the price looks low."),
      category: z.enum(["meat", "seafood", "produce", "dairy", "bakery", "pantry", "frozen", "household"]),
    })
  ),
});

const SYSTEM = `You read grocery store receipts. List every purchased product line with what was paid.
Spell out receipt abbreviations into a plain product name a shopper would recognize. Skip totals, tax,
payment, bag fees, deposits, and anything that isn't a product. Coupon, discount and savings lines are not
products: add their amount to the discount of the product they apply to (usually the product just above,
or the one they name). Skip discounts on the whole order, or ones you can't tie to one product. If a line
shows a weight and a per-lb price, fill pounds. If the image isn't a receipt, set isReceipt to false.`;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A price read from a receipt, as shown to the shopper. */
export interface ScannedItem extends PriceBookItem {
  /** Paid per unit (per lb) when it was a sale; price is then the regular price, if known. */
  salePrice: number | null;
  /** Why we think it was a sale (null when it wasn't). */
  saleReason: SaleReason | null;
  /** False for a sale with no known regular price: not saved as an everyday price. */
  saved: boolean;
}

export interface ScanResult {
  /** True when this receipt was already scanned (no reward). */
  duplicate: boolean;
  receiptId: string;
  storeName: string | null;
  date: string | null;
  items: ScannedItem[];
  inputTokens: number;
  outputTokens: number;
}

export async function scanReceipt(
  db: Firestore,
  anthropic: Anthropic,
  uid: string,
  storeId: string,
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/heic" | "image/webp"
): Promise<ScanResult> {
  const store = await db.doc(`stores/${storeId}`).get();
  if (!store.exists) throw new Error(`Unknown store ${storeId}`);

  const response = await anthropic.beta.messages.parse({
    model: RECEIPT_MODEL,
    max_tokens: 8000,
    output_config: { format: betaZodOutputFormat(ReceiptSchema) },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          // HEIC isn't accepted by the API; the app sends JPEG.
          { type: "image", source: { type: "base64", media_type: mediaType === "image/heic" ? "image/jpeg" : mediaType, data: imageBase64 } },
          { type: "text", text: `Receipt from ${store.get("name")}. List the products and prices.` },
        ],
      },
    ],
  });
  const r = response.parsed_output;
  if (!r) throw new Error("Couldn't read that receipt. Try a flatter, brighter photo.");
  if (!r.isReceipt) throw new Error("That doesn't look like a grocery receipt.");

  const seenAt = r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : new Date().toISOString().slice(0, 10);
  const { book, ads } = await loadComparePrices(db, storeId, store.get("dealsFrom") as string | undefined, store.get("everydayFrom") as string | undefined, seenAt);
  const items: ScannedItem[] = [];
  for (const it of r.items) {
    if (!(it.linePrice > 0)) continue;
    const check = checkLine({ ...it, discount: it.discount ?? null, markedSale: it.markedSale === true }, book, ads);
    // A sale only teaches us the everyday price when we know the regular price too.
    const price = round2(check.regular ?? check.paid);
    if (!(price > 0 && price < 500)) continue;
    items.push({
      name: it.name.slice(0, 90),
      size: it.size,
      price,
      // Receipt prices are history, never a current promo (see loadPriceBook).
      promo: null,
      salePrice: check.sale ? check.paid : null,
      saleReason: check.sale,
      saved: !check.sale || check.regular !== null,
      soldBy: check.soldBy,
      category: it.category,
      source: "receipt",
      seenAt,
    });
  }

  // Merge into the store's receipt book: one entry per product name, newest price wins.
  const ref = db.doc(`receiptPrices/${storeId}`);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const existing = (snap.get("items") as PriceBookItem[] | undefined) ?? [];
    const key = (p: PriceBookItem) => `${words(p.name).join(" ")}|${p.size ?? ""}`;
    const merged = new Map(existing.map((p) => [key(p), p]));
    for (const { saleReason: _r, saved, ...p } of items) {
      if (!saved) continue;
      const old = merged.get(key(p));
      if (!old || old.seenAt <= p.seenAt) merged.set(key(p), p);
    }
    tx.set(ref, {
      storeId,
      chain: store.get("chain") ?? null,
      items: fitToDoc([...merged.values()]),
      updatedAt: new Date().toISOString(),
    });
  });

  // The same receipt scanned twice (by anyone) earns no second reward.
  const fingerprint = createHash("sha256")
    .update([storeId, seenAt, ...r.items.map((p) => `${p.name}:${p.linePrice}`).sort()].join("|"))
    .digest("hex");
  const dupe = await db.collection("receipts").where("fingerprint", "==", fingerprint).limit(1).get();

  // Keep the parsed receipt (not the photo) so prices can be traced and bad scans removed.
  const saved = await db.collection("receipts").add({
    uid,
    storeId,
    storeName: r.storeName,
    date: seenAt,
    lines: r.items,
    fingerprint,
    duplicate: !dupe.empty,
    at: Timestamp.now(),
  });

  return {
    duplicate: !dupe.empty,
    receiptId: saved.id,
    storeName: r.storeName,
    date: seenAt,
    items,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/** Days a receipt can be old and still be compared with the current weekly ad. */
const AD_DAYS = 7;

/**
 * What a receipt line is compared with to spot sales: the store's known everyday prices
 * (its own book, plus the store it shares prices with) and, for a recent receipt, this
 * week's ad deals.
 */
async function loadComparePrices(
  db: Firestore,
  storeId: string,
  dealsFrom: string | undefined,
  everydayFrom: string | undefined,
  seenAt: string
): Promise<{ book: PriceBookItem[]; ads: AdPrice[] }> {
  const book = await loadPriceBook(db, storeId);
  if (everydayFrom && everydayFrom !== storeId) book.push(...(await loadPriceBook(db, everydayFrom)));

  const ageDays = (Date.now() - Date.parse(`${seenAt}T12:00:00Z`)) / 86_400_000;
  const ads: AdPrice[] = [];
  if (ageDays <= AD_DAYS) {
    const snap = await db.collection("deals").where("storeId", "==", dealsFrom ?? storeId).get();
    snap.forEach((d) => {
      const validTo = d.get("validTo") as string | undefined;
      if (validTo && validTo.slice(0, 10) < seenAt) return;
      ads.push({
        name: [d.get("brand"), d.get("name")].filter(Boolean).join(" "),
        size: (d.get("size") as string | null) ?? null,
        soldBy: (d.get("soldBy") as string | null) ?? null,
        salePrice: (d.get("salePrice") as number | null) ?? null,
        regularPrice: (d.get("regularPrice") as number | null) ?? null,
      });
    });
  }
  return { book, ads };
}
