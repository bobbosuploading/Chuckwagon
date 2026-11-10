import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { KrogerClient, KrogerProduct } from "./kroger";
import { fitToDoc, PRICE_BOOK_TERMS, PriceBookItem } from "./priceBook";
import {
  Category,
  KROGER_RADIUS_MILES,
  KROGER_STORE_LIMIT,
  PAGES_PER_TERM,
  PAGE_SIZE,
  SEARCH_TERMS,
} from "./config";

/** One sale item, as stored in Firestore at deals/{storeId}_{productId}. */
export interface Deal {
  storeId: string;
  chain: string;
  productId: string;
  name: string;
  brand: string | null;
  size: string | null;
  soldBy: string | null;
  category: Category;
  krogerCategories: string[];
  imageUrl: string | null;
  /** Null when the ad doesn't say (H-E-B often lists only a promo). */
  regularPrice: number | null;
  salePrice: number | null;
  savings: number | null;
  pctOff: number;
  /** Ad text such as "Buy 2 get 1 free with yellow coupon". */
  promo?: string | null;
  /** When the sale ends (ISO date), if known. */
  validTo?: string;
  source: "kroger-api" | "flipp" | "walmart-api";
  fetchedAt: Timestamp;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function toDeal(p: KrogerProduct, storeId: string, chain: string, category: Category, now: Timestamp): Deal | null {
  const item = p.items?.[0];
  const regular = item?.price?.regular ?? 0;
  const promo = item?.price?.promo ?? 0;
  // Kroger returns promo = 0 when an item is not on sale.
  if (!(regular > 0 && promo > 0 && promo < regular)) return null;
  const front = p.images?.find((i) => i.perspective === "front") ?? p.images?.[0];
  return {
    storeId,
    chain,
    productId: p.productId,
    name: p.description,
    brand: p.brand ?? null,
    size: item?.size ?? null,
    soldBy: item?.soldBy ?? null,
    category,
    krogerCategories: p.categories ?? [],
    imageUrl: front?.sizes.find((s) => s.size === "medium")?.url ?? null,
    regularPrice: regular,
    salePrice: promo,
    savings: round2(regular - promo),
    pctOff: Math.round(((regular - promo) / regular) * 100),
    source: "kroger-api",
    fetchedAt: now,
  };
}

/** Everyday price for the store's price book, for any product with a regular price. */
function toPriceBookItem(p: KrogerProduct, category: Category, seenAt: string): PriceBookItem | null {
  const item = p.items?.[0];
  const regular = item?.price?.regular ?? 0;
  if (!(regular > 0)) return null;
  const promo = item?.price?.promo ?? 0;
  return {
    // Kroger descriptions usually start with the brand already ("Kroger® Salted Butter").
    name: (p.brand && !p.description.toLowerCase().startsWith(p.brand.toLowerCase())
      ? `${p.brand} ${p.description}`
      : p.description
    ).slice(0, 90),
    size: item?.size ?? null,
    price: regular,
    promo: promo > 0 && promo < regular ? promo : null,
    soldBy: item?.soldBy === "WEIGHT" ? "WEIGHT" : "UNIT",
    category,
    source: "kroger-api",
    seenAt,
  };
}

export interface RunSummary {
  stores: number;
  deals: number;
  /** Everyday prices saved to priceBooks/{storeId}, all stores together. */
  prices: number;
  removed: number;
  apiCalls: number;
  errors: string[];
}

/**
 * Pull current Kroger sale items for stores near `zip` and replace them in Firestore.
 * Also saves every product's regular price to the store's price book.
 * With dryRun, nothing is written and the counts are only reported.
 */
export async function collectKrogerDeals(
  clientId: string,
  clientSecret: string,
  zip: string,
  dryRun = false
): Promise<RunSummary> {
  const db = getFirestore();
  const kroger = new KrogerClient(clientId, clientSecret);
  const now = Timestamp.now();
  const seenAt = now.toDate().toISOString().slice(0, 10);
  const summary: RunSummary = { stores: 0, deals: 0, prices: 0, removed: 0, apiCalls: 0, errors: [] };

  const stores = await kroger.storesNear(zip, KROGER_RADIUS_MILES, KROGER_STORE_LIMIT);
  summary.apiCalls++;
  summary.stores = stores.length;
  logger.info(`Found ${stores.length} Kroger stores near ${zip}`, stores.map((s) => `${s.name} (${s.locationId})`));

  const writer = dryRun ? null : db.bulkWriter();

  for (const store of stores) {
    const storeId = `kroger-${store.locationId}`;
    writer?.set(db.doc(`stores/${storeId}`), {
      chain: store.chain,
      name: store.name,
      locationId: store.locationId,
      address: store.address,
      zip: store.address.zipCode ?? null,
      geo: store.geolocation ? { lat: store.geolocation.latitude, lng: store.geolocation.longitude } : null,
      source: "kroger-api",
      updatedAt: now,
    });

    const seen = new Map<string, Deal>();
    const prices = new Map<string, PriceBookItem>();
    const searches: [Category, string, boolean][] = [];
    for (const [category, terms] of Object.entries(SEARCH_TERMS) as [Category, string[]][]) {
      for (const term of terms) searches.push([category, term, true]);
    }
    for (const [category, terms] of Object.entries(PRICE_BOOK_TERMS) as [Category, string[]][]) {
      for (const term of terms) searches.push([category, term, false]);
    }
    for (const [category, term, forDeals] of searches) {
      for (let page = 0; page < PAGES_PER_TERM; page++) {
        try {
          const products = await kroger.searchProducts(term, store.locationId, page * PAGE_SIZE, PAGE_SIZE);
          summary.apiCalls++;
          for (const p of products) {
            // First category wins if a product shows up under several terms.
            if (!prices.has(p.productId)) {
              const price = toPriceBookItem(p, category, seenAt);
              if (price) prices.set(p.productId, price);
            }
            if (seen.has(p.productId)) continue;
            const deal = toDeal(p, storeId, store.chain, category, now);
            if (deal) seen.set(p.productId, deal);
          }
          // The price-book-only searches need just the first page.
          if (products.length < PAGE_SIZE || !forDeals) break;
        } catch (err) {
          const msg = `${store.locationId} "${term}" page ${page}: ${(err as Error).message}`;
          logger.warn(msg);
          summary.errors.push(msg);
          break;
        }
      }
    }

    const book = fitToDoc([...prices.values()]);
    summary.deals += seen.size;
    summary.prices += book.length;
    logger.info(`${store.name}: ${seen.size} deals, ${book.length} everyday prices`);
    if (!writer) continue;

    for (const deal of seen.values()) {
      writer.set(db.doc(`deals/${storeId}_${deal.productId}`), deal);
    }
    writer.set(db.doc(`priceBooks/${storeId}`), {
      storeId,
      chain: store.chain,
      items: book,
      updatedAt: now.toDate().toISOString(),
    });

    // Make sure this run's writes have landed before looking for stale deals,
    // otherwise a deal we just re-saved could be read with its old timestamp and deleted.
    await writer.flush();

    // Remove this store's deals that were not seen in this run (sale ended).
    const stale = await db
      .collection("deals")
      .where("storeId", "==", storeId)
      .where("fetchedAt", "<", now)
      .get();
    stale.forEach((d) => writer.delete(d.ref));
    summary.removed += stale.size;
  }

  if (!writer) return summary;
  await writer.close();
  await db.collection("runs").add({ type: "kroger", zip, at: now, ...summary });
  return summary;
}
