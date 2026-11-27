/**
 * Barcode lookup for the shopping list: a scanned UPC/EAN becomes a product name with its brand
 * and size ("Weiman Daily Cooktop Cleaner, 12 oz"), so a shopper can add the exact thing they buy.
 *
 * Free sources, tried in order:
 *   1. Open Food Facts, Open Products Facts, Open Beauty Facts (open databases, no key)
 *   2. UPCitemdb's free trial lookup (no key, about 100 lookups a day per server address)
 *   3. Kroger's product API (the app's existing Kroger keys), when they're set
 * Answers, found or not, are kept in barcodes/{code} so a barcode is only looked up once
 * (misses are tried again after a week, in case a database adds it).
 */
import { Firestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { KrogerClient } from "./kroger";

const USER_AGENT = "Chuckwagon/0.1 (https://chuckwagon-ebbcc.web.app)";
const MISS_DAYS = 7;
const TIMEOUT_MS = 6000;

export interface BarcodeProduct {
  /** What goes on the list: brand, product and size. */
  name: string;
  brand: string;
  size: string;
  source: string;
}

/** Digits only, and UPC-E (8 digits starting with 0 or 1) expanded to its 12-digit UPC-A. */
export function normalizeBarcode(raw: unknown): string | null {
  const code = String(raw ?? "").replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(code.length)) return null;
  if (code.length === 8 && (code[0] === "0" || code[0] === "1")) {
    const expanded = expandUpcE(code);
    if (expanded) return expanded;
  }
  return code;
}

function expandUpcE(e: string): string | null {
  const [ns, d1, d2, d3, d4, d5, d6, check] = e.split("");
  let body: string;
  switch (d6) {
    case "0":
    case "1":
    case "2":
      body = `${d1}${d2}${d6}0000${d3}${d4}${d5}`;
      break;
    case "3":
      body = `${d1}${d2}${d3}00000${d4}${d5}`;
      break;
    case "4":
      body = `${d1}${d2}${d3}${d4}00000${d5}`;
      break;
    default:
      body = `${d1}${d2}${d3}${d4}${d5}0000${d6}`;
  }
  const upcA = `${ns}${body}${check}`;
  return upcA.length === 12 ? upcA : null;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** "Weiman" + "Daily Cooktop Cleaner" + "12 oz" -> "Weiman Daily Cooktop Cleaner, 12 oz". */
export function productName(brand: string, name: string, size: string): string {
  const b = clean(brand).split(",")[0].trim();
  let n = clean(name);
  if (b && !n.toLowerCase().includes(b.toLowerCase())) n = `${b} ${n}`;
  const s = clean(size);
  const key = (t: string) => t.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s && !key(n).includes(key(s))) n = `${n}, ${s}`;
  return n.slice(0, 120);
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** One of the Open ... Facts databases (same API). */
async function openFacts(host: string, code: string, source: string): Promise<BarcodeProduct | null> {
  const json = (await getJson(`https://${host}/api/v2/product/${code}.json?fields=product_name,product_name_en,generic_name,brands,quantity`)) as {
    status?: number;
    product?: Record<string, unknown>;
  } | null;
  const p = json?.status === 1 ? json.product : undefined;
  if (!p) return null;
  const name = clean(p.product_name_en) || clean(p.product_name) || clean(p.generic_name);
  if (!name) return null;
  const brand = clean(p.brands).split(",")[0].trim();
  const size = clean(p.quantity);
  return { name: productName(brand, name, size), brand, size, source };
}

async function upcItemDb(code: string): Promise<BarcodeProduct | null> {
  const json = (await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`)) as {
    items?: { title?: string; brand?: string; size?: string }[];
  } | null;
  const item = json?.items?.[0];
  const title = clean(item?.title);
  if (!item || !title) return null;
  const brand = clean(item.brand);
  const size = clean(item.size);
  return { name: productName(brand, title, size), brand, size, source: "upcitemdb" };
}

/** Kroger product ids are the UPC as 13 digits; try without and with the check digit. */
async function kroger(code: string): Promise<BarcodeProduct | null> {
  const id = process.env.KROGER_CLIENT_ID ?? "";
  const secret = process.env.KROGER_CLIENT_SECRET ?? "";
  if (!id || !secret) return null;
  const client = new KrogerClient(id, secret);
  const candidates = [...new Set([code.slice(0, -1).padStart(13, "0"), code.padStart(13, "0").slice(-13)])];
  for (const productId of candidates) {
    try {
      const p = await client.productById(productId);
      if (p?.description) {
        const size = clean(p.items?.[0]?.size);
        const brand = clean(p.brand);
        return { name: productName(brand, p.description, size), brand, size, source: "kroger" };
      }
    } catch (err) {
      logger.info("Kroger barcode lookup failed", { productId, err: String(err) });
    }
  }
  return null;
}

/** The product for a barcode, or null if no free source knows it. Cached in barcodes/{code}. */
export async function lookupBarcode(db: Firestore, code: string): Promise<BarcodeProduct | null> {
  const ref = db.collection("barcodes").doc(code);
  const cached = await ref.get();
  if (cached.exists) {
    const found = cached.get("product") as BarcodeProduct | null | undefined;
    const checkedAt = Date.parse(cached.get("checkedAt") as string);
    if (found) return found;
    if (Date.now() - checkedAt < MISS_DAYS * 86_400_000) return null;
  }
  // The three open databases at once (they're quick and free), then the others in turn.
  const open = await Promise.all([
    openFacts("world.openfoodfacts.org", code, "openfoodfacts"),
    openFacts("world.openproductsfacts.org", code, "openproductsfacts"),
    openFacts("world.openbeautyfacts.org", code, "openbeautyfacts"),
  ]);
  const product = open.find((p) => p) ?? (await upcItemDb(code)) ?? (await kroger(code));
  await ref.set({ product, checkedAt: new Date().toISOString() });
  logger.info("Barcode looked up", { code, found: !!product, source: product?.source });
  return product;
}
