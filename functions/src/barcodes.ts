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
import { KrogerClient, type KrogerProduct } from "./kroger";

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

/** What a source said: a product, a clear "not in our database", or an error (blocked, rate-limited, down). */
type SourceResult = { product: BarcodeProduct | null; error: string | null };
const found = (product: BarcodeProduct): SourceResult => ({ product, error: null });
const missing: SourceResult = { product: null, error: null };
const failed = (error: string): SourceResult => ({ product: null, error });

async function getJson(url: string): Promise<{ json: unknown; status: number } | { error: string }> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status === 404) return { json: null, status: 404 };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { json: await res.json(), status: res.status };
  } catch (err) {
    return { error: String(err).slice(0, 120) };
  }
}

/**
 * The barcode as the different sources like it. Phones read UPC-A barcodes (most US products)
 * as 13-digit EAN with a leading 0; Open ... Facts and UPCitemdb are surest with the 12 digits.
 */
export function barcodeVariants(code: string): string[] {
  const out = [code];
  if (code.length === 13 && code.startsWith("0")) out.unshift(code.slice(1));
  if (code.length === 12) out.push(`0${code}`);
  return [...new Set(out)];
}

/** One of the Open ... Facts databases (same API). */
async function openFacts(host: string, code: string, source: string): Promise<SourceResult> {
  const r = await getJson(`https://${host}/api/v2/product/${code}.json?fields=product_name,product_name_en,generic_name,brands,quantity`);
  if ("error" in r) return failed(r.error);
  const json = r.json as { status?: number; product?: Record<string, unknown> } | null;
  const p = json?.status === 1 ? json.product : undefined;
  if (!p) return missing;
  const name = clean(p.product_name_en) || clean(p.product_name) || clean(p.generic_name);
  if (!name) return missing;
  const brand = clean(p.brands).split(",")[0].trim();
  const size = clean(p.quantity);
  return found({ name: productName(brand, name, size), brand, size, source });
}

async function upcItemDb(code: string): Promise<SourceResult> {
  const r = await getJson(`https://api.upcitemdb.com/prod/trial/lookup?upc=${code}`);
  if ("error" in r) return failed(r.error);
  const json = r.json as { code?: string; items?: { title?: string; brand?: string; size?: string }[] } | null;
  if (json?.code && json.code !== "OK") return failed(`upcitemdb ${json.code}`);
  const item = json?.items?.[0];
  const title = clean(item?.title);
  if (!item || !title) return missing;
  const brand = clean(item.brand);
  const size = clean(item.size);
  return found({ name: productName(brand, title, size), brand, size, source: "upcitemdb" });
}

function fromKroger(p: KrogerProduct): BarcodeProduct {
  const size = clean(p.items?.[0]?.size);
  const brand = clean(p.brand);
  return { name: productName(brand, p.description, size), brand, size, source: "kroger" };
}

/**
 * Kroger product ids are the UPC as 13 digits without its check digit (041598000706 ->
 * 0004159800070). Tries that, the full code, then a search for the digits.
 */
async function kroger(code: string): Promise<SourceResult> {
  const id = process.env.KROGER_CLIENT_ID ?? "";
  const secret = process.env.KROGER_CLIENT_SECRET ?? "";
  if (!id || !secret) return missing;
  const client = new KrogerClient(id, secret);
  const upc12 = code.length === 13 && code.startsWith("0") ? code.slice(1) : code;
  const candidates = [...new Set([upc12.slice(0, -1).padStart(13, "0"), upc12.padStart(13, "0").slice(-13)])];
  let error: string | null = null;
  for (const productId of candidates) {
    try {
      const p = await client.productById(productId);
      if (p?.description) return found(fromKroger(p));
    } catch (err) {
      error = String(err).slice(0, 160);
    }
  }
  try {
    const hits = await client.searchProductsAnywhere(upc12, 5);
    const digits = (s: string | undefined) => (s ?? "").replace(/^0+/, "");
    const match = hits.find((p) => p.description && candidates.some((c) => digits(p.upc) === digits(c) || digits(p.productId) === digits(c)));
    if (match) return found(fromKroger(match));
  } catch (err) {
    error = String(err).slice(0, 160);
  }
  return error ? failed(error) : missing;
}

/** Bump when lookups change, so misses cached by older code are tried again. */
const LOOKUP_VERSION = 2;

/** The product for a barcode, or null if no free source knows it. Cached in barcodes/{code}. */
export async function lookupBarcode(db: Firestore, code: string): Promise<BarcodeProduct | null> {
  const ref = db.collection("barcodes").doc(code);
  const cached = await ref.get();
  if (cached.exists) {
    const product = cached.get("product") as BarcodeProduct | null | undefined;
    const checkedAt = Date.parse(cached.get("checkedAt") as string);
    if (product) return product;
    if (cached.get("version") === LOOKUP_VERSION && Date.now() - checkedAt < MISS_DAYS * 86_400_000) return null;
  }

  const report: Record<string, string> = {};
  const note = (name: string, r: SourceResult) => {
    report[name] = r.product ? "found" : r.error ?? "not found";
    return r.product;
  };
  const [first, ...rest] = barcodeVariants(code);
  let product: BarcodeProduct | null = null;
  for (const variant of [first, ...rest]) {
    // The three open databases at once (they're quick and free).
    const open = await Promise.all([
      openFacts("world.openfoodfacts.org", variant, "openfoodfacts"),
      openFacts("world.openproductsfacts.org", variant, "openproductsfacts"),
      openFacts("world.openbeautyfacts.org", variant, "openbeautyfacts"),
    ]);
    product =
      note(`off ${variant}`, open[0]) ?? note(`opf ${variant}`, open[1]) ?? note(`obf ${variant}`, open[2]) ??
      note(`upcitemdb ${variant}`, await upcItemDb(variant));
    if (product) break;
  }
  product ??= note("kroger", await kroger(code));

  const anyErrors = Object.values(report).some((v) => v !== "found" && v !== "not found");
  logger.info("Barcode looked up", { code, found: !!product, source: product?.source, report });
  // Keep finds for good. Keep misses only when every source answered, so a blocked or
  // rate-limited source gets another try next scan.
  if (product || !anyErrors) {
    await ref.set({ product, checkedAt: new Date().toISOString(), version: LOOKUP_VERSION });
  }
  return product;
}
