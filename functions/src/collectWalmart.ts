import { Firestore, getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Deal } from "./collectKroger";
import {
  Category,
  SEARCH_TERMS,
  WALMART_CATEGORY_IDS,
  WALMART_ITEMS_PER_TERM,
  WALMART_MAX_ITEMS,
  WALMART_MIN_DROP,
} from "./config";
import { WalmartAuth, WalmartClient, WalmartItem } from "./walmart";

/**
 * Walmart prices from the Walmart Affiliate API.
 *
 * Every run prices the same few hundred common items for the home ZIP and keeps a short
 * price history per item in walmartPrices/{itemId}. An item becomes a deal when:
 *   - Walmart marks it Rollback, Clearance or Special Buy, or
 *   - it shows a crossed-out "was" price, or
 *   - today's price is at least WALMART_MIN_DROP below its usual (median) price.
 * Prices are walmart.com prices for the ZIP, which usually but not always match the shelf.
 */

/** One day's price, as kept in walmartPrices/{itemId}.history. */
export interface PricePoint { d: string; p: number }

export interface WalmartPriceDoc {
  itemId: number;
  name: string;
  category: Category;
  history: PricePoint[];
  lastSeen: Timestamp;
}

const HISTORY_DAYS = 60;
const HISTORY_MAX = 40;
/** Need this many earlier prices before "below usual price" counts. */
const MIN_HISTORY = 3;
const ALLOWED_PATHS = /^(Food|Household Essentials|Health|Personal Care|Baby|Pets)\b/i;

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Usual price from earlier runs (not today), or null if there isn't enough history yet. */
export function usualPrice(history: PricePoint[], day: string): number | null {
  const cutoff = new Date(Date.parse(day) - HISTORY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const earlier = history.filter((h) => h.d < day && h.d >= cutoff).map((h) => h.p);
  return earlier.length >= MIN_HISTORY ? round2(median(earlier)) : null;
}

/** Turns one priced item into a deal, or null when it's just the everyday price. */
export function toWalmartDeal(
  it: WalmartItem,
  category: Category,
  storeId: string,
  history: PricePoint[],
  day: string,
  now: Timestamp
): Deal | null {
  const price = it.salePrice;
  if (!price || price <= 0) return null;

  const flag = it.rollBack ? "Rollback" : it.clearance ? "Clearance" : it.specialBuy ? "Special Buy" : null;
  const usual = usualPrice(history, day);
  const candidates: number[] = [];
  if (it.strikeThroughPrice && it.strikeThroughPrice > price) candidates.push(it.strikeThroughPrice);
  if (usual && usual > price) candidates.push(usual);
  // MSRP is often a made-up list price, so trust it only when Walmart flags the item and it's believable.
  if (flag && it.msrp && it.msrp > price && it.msrp <= price * 1.6) candidates.push(it.msrp);
  const regular = candidates.length ? Math.max(...candidates) : null;

  const drop = regular ? (regular - price) / regular : 0;
  if (!flag && drop < WALMART_MIN_DROP) return null;

  const why = flag ?? (usual && regular === usual ? `Price drop, usually $${usual.toFixed(2)}` : "Price drop");
  const savings = regular ? round2(regular - price) : null;
  const perLb = /\bper lb\b|\/lb\b/i.test(it.name);
  return {
    storeId,
    chain: "Walmart",
    productId: `wm-${it.itemId}`,
    name: it.name,
    brand: it.brandName ?? null,
    size: it.attributes?.size ?? null,
    soldBy: perLb ? "WEIGHT" : "UNIT",
    category,
    krogerCategories: [],
    imageUrl: it.mediumImage ?? it.thumbnailImage ?? null,
    regularPrice: regular,
    salePrice: price,
    savings,
    // Flagged items with no known regular price still sort above nothing.
    pctOff: regular ? Math.round(drop * 100) : 5,
    promo: `${why}. Walmart.com price; check the shelf.`,
    source: "walmart-api",
    fetchedAt: now,
  };
}

function inStore(it: WalmartItem): boolean {
  if (it.marketplace) return false; // third-party seller
  if (it.offerType && !/STORE/i.test(it.offerType)) return false; // online only
  if (it.categoryPath && !ALLOWED_PATHS.test(it.categoryPath)) return false;
  return !!it.salePrice;
}

export interface WalmartSummary {
  store: string;
  watched: number;
  priced: number;
  deals: number;
  removed: number;
  apiCalls: number;
  errors: string[];
}

/** Finds the items to watch: best sellers per search term, plus anything watched recently. */
async function watchList(wm: WalmartClient, db: Firestore | null, errors: string[]) {
  const watch = new Map<number, Category>();
  for (const [category, terms] of Object.entries(SEARCH_TERMS) as [Category, string[]][]) {
    const categoryId = WALMART_CATEGORY_IDS[category] ?? WALMART_CATEGORY_IDS.default;
    for (const term of terms) {
      try {
        let items = await wm.search(term, categoryId);
        if (items.length === 0) items = await wm.search(term);
        let kept = 0;
        for (const it of items) {
          if (kept >= WALMART_ITEMS_PER_TERM) break;
          if (!inStore(it) || watch.has(it.itemId)) continue;
          watch.set(it.itemId, category);
          kept++;
        }
      } catch (err) {
        errors.push(`search "${term}": ${(err as Error).message}`);
      }
    }
  }
  if (db) {
    const cutoff = Timestamp.fromMillis(Date.now() - 21 * 86_400_000);
    const recent = await db.collection("walmartPrices").where("lastSeen", ">=", cutoff).get();
    recent.forEach((d) => {
      const doc = d.data() as WalmartPriceDoc;
      if (!watch.has(doc.itemId)) watch.set(doc.itemId, doc.category);
    });
  }
  return [...watch.entries()].slice(0, WALMART_MAX_ITEMS);
}

/** Prices the watch list for `zip`, saves history, and replaces Walmart deals. dryRun writes nothing. */
export async function collectWalmartDeals(auth: WalmartAuth, zip: string, dryRun = false) {
  const wm = new WalmartClient(auth);
  const db = dryRun ? null : getFirestore();
  const now = Timestamp.now();
  const day = today();
  const summary: WalmartSummary = { store: "", watched: 0, priced: 0, deals: 0, removed: 0, apiCalls: 0, errors: [] };

  let stores: Awaited<ReturnType<WalmartClient["storesNear"]>> = [];
  try {
    stores = await wm.storesNear(zip);
  } catch (err) {
    summary.errors.push(`stores: ${(err as Error).message}`);
  }
  const store = stores[0];
  const storeId = store ? `walmart-${store.no}` : `walmart-${zip}`;
  summary.store = store ? `${store.name} #${store.no}, ${store.city}` : `near ${zip}`;

  const watch = await watchList(wm, db, summary.errors);
  summary.watched = watch.length;
  const categoryOf = new Map(watch);

  const priced: WalmartItem[] = [];
  for (let i = 0; i < watch.length; i += 20) {
    const ids = watch.slice(i, i + 20).map(([id]) => id);
    try {
      priced.push(...(await wm.lookup(ids, zip)).filter(inStore));
    } catch (err) {
      summary.errors.push(`lookup ${ids[0]}..: ${(err as Error).message}`);
    }
  }
  summary.priced = priced.length;

  // Earlier prices, to spot drops.
  const histories = new Map<number, PricePoint[]>();
  if (db && priced.length) {
    const refs = priced.map((it) => db.doc(`walmartPrices/${it.itemId}`));
    for (let i = 0; i < refs.length; i += 100) {
      const snaps = await db.getAll(...refs.slice(i, i + 100));
      for (const s of snaps) if (s.exists) histories.set(Number(s.id), (s.data() as WalmartPriceDoc).history ?? []);
    }
  }

  const deals: Deal[] = [];
  for (const it of priced) {
    const history = histories.get(it.itemId) ?? [];
    const deal = toWalmartDeal(it, categoryOf.get(it.itemId) ?? "pantry", storeId, history, day, now);
    if (deal) deals.push(deal);
  }
  summary.deals = deals.length;
  summary.apiCalls = wm.apiCalls;
  if (!db) return { summary, deals, priced };

  const writer = db.bulkWriter();
  writer.set(db.doc(`stores/${storeId}`), {
    chain: "Walmart",
    name: store ? store.name.replace(/^WM\b/, "Walmart") : "Walmart",
    ...(store ? { locationId: String(store.no) } : {}),
    address: {
      addressLine1: store?.streetAddress ?? "Walmart.com prices",
      city: store?.city ?? `near ${zip}`,
      state: store?.stateProvCode ?? "",
      zipCode: store?.zip ?? zip,
    },
    source: "walmart-api",
    updatedAt: now,
  }, { merge: true });

  for (const it of priced) {
    const history = (histories.get(it.itemId) ?? []).filter((h) => h.d !== day);
    history.push({ d: day, p: it.salePrice! });
    const doc: WalmartPriceDoc = {
      itemId: it.itemId,
      name: it.name,
      category: categoryOf.get(it.itemId) ?? "pantry",
      history: history.slice(-HISTORY_MAX),
      lastSeen: now,
    };
    writer.set(db.doc(`walmartPrices/${it.itemId}`), doc);
  }
  for (const d of deals) writer.set(db.doc(`deals/${storeId}_${d.productId}`), d);
  await writer.flush();

  const stale = await db.collection("deals").where("storeId", "==", storeId).where("fetchedAt", "<", now).get();
  stale.forEach((d) => writer.delete(d.ref));
  summary.removed = stale.size;
  await writer.close();
  await db.collection("runs").add({ type: "walmart", zip, at: now, ...summary });
  return { summary, deals, priced };
}
