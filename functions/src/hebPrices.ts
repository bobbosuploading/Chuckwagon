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
import { getFirestore } from "firebase-admin/firestore";
import type { Category } from "./config";
import { fitToDoc, PriceBookItem, words } from "./priceBook";

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
  const summary = { zip, rows: rows.length, prices: items.length, store: storeName, saved: false };
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
  await db.collection("runs").add({ type: "heb-prices", at: new Date(), ...summary });
  return { summary, items };
}
