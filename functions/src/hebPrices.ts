/**
 * H-E-B everyday shelf prices for the beta, from a third-party Apify scraper
 * (https://apify.com/zaiq/heb-scraper). heb.com has no API, so this is scraping:
 * fine for TestFlight, but turn it off (HEB_PRICES_ENABLED) before a paid launch.
 *
 * Kept inside Apify's free plan ($5 of usage a month): the actor charges about
 * $0.006 per product, so one run of at most 750 products costs about $4.50, and the
 * run is capped at HEB_MAX_CHARGE_USD so it can never cost more.
 *
 * Results are merged into priceBooks/heb-{zip}; items not seen this run are kept for
 * up to KEEP_DAYS, so different staples can be covered in different months.
 */
import { Firestore, getFirestore } from "firebase-admin/firestore";
import type { Deal } from "./collectKroger";
import { withStockUp } from "./stockUp";
import type { Category } from "./config";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { bookUnitPrice } from "./clubPrices";
import { fitToDoc, PriceBookItem, shortlist, words } from "./priceBook";
import { MATCH_MODEL } from "./priceItems";

const ACTOR = "zaiq~heb-scraper";
const API = "https://api.apify.com/v2";
export const HEB_MAX_ITEMS = 750;
export const HEB_MAX_CHARGE_USD = 4.5;
const PER_TERM = 9;
const KEEP_DAYS = 120;

/** 79 staples x 9 products = 711 rows, inside the free plan's monthly budget. */
export const HEB_TERMS: Record<Exclude<Category, "household">, string[]> = {
  meat: ["chicken breast", "chicken thighs", "ground beef", "ground turkey", "pork chops", "bacon", "smoked sausage", "ham", "chuck roast", "fajita beef", "chicken drumsticks", "hot dogs"],
  seafood: ["tilapia", "shrimp", "salmon", "canned tuna"],
  produce: ["onions", "potatoes", "garlic", "tomatoes", "bell peppers", "jalapeno", "cilantro", "limes", "lemons", "carrots", "celery", "broccoli", "lettuce", "spinach", "avocado", "bananas", "apples", "cabbage", "zucchini", "mushrooms", "green onions", "sweet potatoes", "corn on the cob"],
  dairy: ["milk", "eggs", "butter", "shredded cheese", "sliced cheese", "sour cream", "cream cheese", "yogurt", "heavy cream", "parmesan"],
  bakery: ["bread", "flour tortillas", "corn tortillas", "hamburger buns"],
  pantry: ["rice", "pasta", "spaghetti sauce", "pinto beans", "black beans", "canned tomatoes", "tomato sauce", "chicken broth", "flour", "sugar", "vegetable oil", "olive oil", "soy sauce", "salsa", "taco seasoning", "ketchup", "mayonnaise", "mustard", "peanut butter", "cereal", "oats", "ramen", "mac and cheese"],
  frozen: ["frozen vegetables", "frozen corn", "frozen broccoli"],
};

interface HebRow {
  productId?: string;
  name?: string;
  brand?: string | null;
  size?: string | null;
  price?: number | null;
  regularPrice?: number | null;
  salePrice?: number | null;
  soldByWeight?: boolean | null;
  storeId?: string;
  storeName?: string;
  error?: string;
}

async function apify<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Apify ${path} -> HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Runs the scraper and waits for it (a run takes several minutes). */
async function runScraper(token: string, zip: string, maxItems: number): Promise<HebRow[]> {
  const terms = Object.values(HEB_TERMS).flat();
  const input = {
    searchTerms: terms,
    zipCodes: [zip],
    storesPerZip: 1,
    maxItemsPerQuery: PER_TERM,
    maxItems,
    includeDetails: false,
    includeFailures: false,
    trackPrices: false,
  };
  const charge = Math.min(HEB_MAX_CHARGE_USD, Math.ceil(maxItems * 0.006 * 100 + 5) / 100);
  const started = await apify<{ data: { id: string; defaultDatasetId: string } }>(
    token,
    `/acts/${ACTOR}/runs?maxItems=${maxItems}&maxTotalChargeUsd=${charge}`,
    { method: "POST", body: JSON.stringify(input) }
  );
  const runId = started.data.id;
  for (let waited = 0; ; waited += 30) {
    const run = await apify<{ data: { status: string; defaultDatasetId: string } }>(token, `/actor-runs/${runId}?waitForFinish=60`);
    const status = run.data.status;
    if (status === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      // A run stopped by the charge cap still has the rows it saved; keep them.
      console.warn(`Apify run ${runId} ended ${status}; using what it saved`);
      break;
    }
    if (waited > 60 * 60) throw new Error(`Apify run ${runId} still ${status} after an hour`);
  }
  const res = await fetch(`${API}/datasets/${started.data.defaultDatasetId}/items?clean=true&format=json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Apify dataset -> HTTP ${res.status}`);
  return (await res.json()) as HebRow[];
}

function categoryFor(name: string): Category | null {
  const w = new Set(words(name));
  for (const [cat, terms] of Object.entries(HEB_TERMS) as [Category, string[]][]) {
    if (terms.some((t) => words(t).every((x) => w.has(x)))) return cat;
  }
  return null;
}

export async function collectHebPrices(token: string, zip: string, opts: { dryRun?: boolean; maxItems?: number } = {}) {
  const maxItems = Math.min(opts.maxItems ?? HEB_MAX_ITEMS, HEB_MAX_ITEMS);
  const rows = await runScraper(token, zip, maxItems);
  const seenAt = new Date().toISOString().slice(0, 10);
  const items: PriceBookItem[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.error || !r.name || !r.productId || seen.has(r.productId)) continue;
    const regular = r.regularPrice ?? r.price ?? null;
    if (!(regular && regular > 0)) continue;
    seen.add(r.productId);
    const sale = r.salePrice && r.salePrice > 0 && r.salePrice < regular ? r.salePrice : null;
    const name = r.brand && !r.name.toLowerCase().startsWith(r.brand.toLowerCase()) ? `${r.brand} ${r.name}` : r.name;
    items.push({
      name: name.slice(0, 90),
      size: r.size ?? null,
      price: regular,
      promo: sale,
      soldBy: r.soldByWeight ? "WEIGHT" : "UNIT",
      category: categoryFor(r.name),
      source: "heb-apify",
      seenAt,
    });
  }
  const storeName = rows.find((r) => r.storeName)?.storeName ?? null;
  const summary = { zip, rows: rows.length, prices: items.length, store: storeName, saved: false, adDealsPriced: 0 };
  if (opts.dryRun || items.length === 0) return { summary, items };

  // Merge with earlier runs: newest price per product name wins; drop prices older than KEEP_DAYS.
  const db = getFirestore();
  const storeId = `heb-${zip}`;
  const ref = db.doc(`priceBooks/${storeId}`);
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = (p: PriceBookItem) => `${words(p.name).join(" ")}|${p.size ?? ""}`;
    const merged = new Map<string, PriceBookItem>();
    for (const p of (snap.get("items") as PriceBookItem[] | undefined) ?? []) {
      if (p.seenAt >= cutoff) merged.set(key(p), p);
    }
    for (const p of items) merged.set(key(p), p);
    tx.set(ref, {
      storeId,
      chain: "H-E-B",
      storeName,
      items: fitToDoc([...merged.values()]),
      updatedAt: new Date().toISOString(),
      source: "heb-apify",
    });
  });
  summary.saved = true;
  const ad = await enrichHebDeals(db, storeId);
  summary.adDealsPriced = ad.enriched;
  await db.collection("runs").add({ type: "heb-prices", at: new Date(), ...summary });
  return { summary, items };
}

const MAX_PCT = 70;

const MatchSchema = z.object({
  picks: z.array(
    z.object({
      item: z.number().int().describe("The AD ITEM number"),
      same: z.array(z.string()).describe("Letters of the shelf products that are the advertised product"),
    })
  ),
});

const MATCH_SYSTEM = `You match grocery weekly-ad items to the same store's shelf products, so the regular price can be shown next to the sale price.
For each AD ITEM, list the letters of the shelf products that ARE the advertised product: the same food, same brand or tier
when the ad names one, same form (raw vs cooked, boneless vs bone-in, plain vs seasoned or breaded, fresh vs frozen).
An ad may cover several products ("drumsticks or thighs"); a product matching any one of them counts.
For items sold "each", the package size must also match what the ad says, when the ad gives a size.
Never match a different food that shares a word. Return an empty list when unsure.`;

/**
 * The H-E-B weekly ad gives a sale price but rarely the regular price, so most ad items
 * show no savings. Fills regularPrice, savings and pctOff from priceBooks/heb-{zip}.
 *
 * A word shortlist finds candidate shelf products, and one small Haiku call says which are
 * really the advertised product (word matching alone found almost nothing: ad names are short
 * and often cover two products). Per-lb ad items compare with shelf prices per lb, worked out
 * from the pack weight when the shelf price is for a pack ("Avg. 3.1 lbs"). When several
 * products match, the lowest regular price above the sale price is used, so savings are never
 * overstated. Deals that already have a regular price are left alone.
 * Without ANTHROPIC_API_KEY nothing is matched.
 */
export async function enrichHebDeals(
  db: Firestore,
  storeId: string,
  bookId = storeId
): Promise<{ checked: number; enriched: number }> {
  const book = ((await db.doc(`priceBooks/${bookId}`).get()).get("items") as PriceBookItem[] | undefined) ?? [];
  const deals = await db.collection("deals").where("storeId", "==", storeId).get();
  if (book.length === 0 || !process.env.ANTHROPIC_API_KEY) return { checked: deals.size, enriched: 0 };

  type Cand = { p: PriceBookItem; regular: number };
  const letters = "abcdefghij";
  const lines: string[] = [];
  const options: { doc: (typeof deals.docs)[number]; sale: number; cands: Cand[] }[] = [];
  for (const doc of deals.docs) {
    const d = doc.data();
    const sale = d.salePrice as number | null;
    if (d.regularPrice != null || !(sale && sale > 0) || d.category === "household") continue;
    const perLb = d.soldBy === "WEIGHT";
    const cands: Cand[] = [];
    for (const p of shortlist(d.name as string, book, 25)) {
      let regular: number | null = null;
      if (perLb) {
        const u = bookUnitPrice(p);
        if (u?.unit === "lb") regular = u.unitPrice;
      } else if (p.soldBy === "UNIT") {
        regular = p.price;
      }
      if (regular === null || regular <= sale || cands.length >= letters.length) continue;
      cands.push({ p, regular });
    }
    if (!cands.length) continue;
    options.push({ doc, sale, cands });
    lines.push(`AD ITEM ${options.length}: ${d.name}${d.size ? ` | ${d.size}` : ""} | sold ${perLb ? "per lb" : "each"}`);
    cands.forEach((c, j) => lines.push(`  ${letters[j]}) ${c.p.name}${c.p.size ? ` | ${c.p.size}` : ""}`));
  }
  if (!options.length) return { checked: deals.size, enriched: 0 };

  let picks: z.infer<typeof MatchSchema>["picks"] = [];
  try {
    const response = await new Anthropic().beta.messages.parse({
      model: MATCH_MODEL,
      max_tokens: 8000,
      output_config: { format: betaZodOutputFormat(MatchSchema) },
      system: MATCH_SYSTEM,
      messages: [{ role: "user", content: lines.join("\n") }],
    });
    picks = response.parsed_output?.picks ?? [];
  } catch (err) {
    console.warn(`Matching H-E-B ad items to shelf prices failed: ${(err as Error).message}`);
    return { checked: deals.size, enriched: 0 };
  }

  const writer = db.bulkWriter();
  let enriched = 0;
  for (const pick of picks) {
    const opt = options[pick.item - 1];
    if (!opt) continue;
    const matched = pick.same
      .map((l) => opt.cands[letters.indexOf(l.trim().toLowerCase())])
      .filter((c): c is Cand => !!c);
    if (!matched.length) continue;
    const best = matched.reduce((a, b) => (b.regular < a.regular ? b : a));
    const regularPrice = Math.round(best.regular * 100) / 100;
    const pctOff = Math.round(((regularPrice - opt.sale) / regularPrice) * 100);
    if (pctOff < 1 || pctOff > MAX_PCT) continue;
    const update = {
      regularPrice,
      savings: Math.round((regularPrice - opt.sale) * 100) / 100,
      pctOff,
      regularPriceSource: "heb-apify",
      regularPriceFrom: best.p.name,
    };
    writer.update(opt.doc.ref, { ...update, stockUp: withStockUp({ ...(opt.doc.data() as Deal), ...update }).stockUp });
    console.log(`  regular price: ${opt.doc.get("name")} $${opt.sale} -> was $${regularPrice} (${pctOff}% off) from "${best.p.name}"`);
    enriched++;
  }
  await writer.close();
  return { checked: deals.size, enriched };
}
