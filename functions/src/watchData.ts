/**
 * Loads what the sale watch (saleWatch.ts) needs from Firestore: each store's current deals,
 * its everyday prices, and the per-lb prices we've seen there before.
 */
import type { Firestore } from "firebase-admin/firestore";
import type { Category } from "./config";
import { loadPriceBook } from "./priceBook";
import { bookOffers, HISTORY_DAYS, Offer, PriceHistory, todaysPrices } from "./saleWatch";

export interface WatchStore {
  /** The store whose deals these are (stores in a price region share one). Offers carry this id. */
  sourceId: string;
  name: string;
  offers: Offer[];
  history: PriceHistory;
}

/** Caches stores for one run, so shoppers with the same stores share the reads. */
export class WatchStoreCache {
  private stores = new Map<string, Promise<WatchStore | null>>();
  constructor(private db: Firestore) {}

  get(storeId: string): Promise<WatchStore | null> {
    let hit = this.stores.get(storeId);
    if (!hit) {
      hit = this.load(storeId);
      this.stores.set(storeId, hit);
    }
    return hit;
  }

  /** The shopper's stores, one entry per deal source. */
  async many(storeIds: string[]): Promise<WatchStore[]> {
    const loaded = (await Promise.all(storeIds.map((id) => this.get(id)))).filter((s): s is WatchStore => !!s);
    const seen = new Set<string>();
    return loaded.filter((s) => !seen.has(s.sourceId) && seen.add(s.sourceId));
  }

  private async load(storeId: string): Promise<WatchStore | null> {
    const store = await this.db.doc(`stores/${storeId}`).get();
    if (!store.exists) return null;
    const sourceId = (store.get("dealsFrom") as string | undefined) || storeId;
    const everydayFrom = (store.get("everydayFrom") as string | undefined) || null;
    const name = String(store.get("name") ?? "your store");
    const [deals, own, shared, hist] = await Promise.all([
      this.db.collection("deals").where("storeId", "==", sourceId).get(),
      loadPriceBook(this.db, storeId),
      everydayFrom && everydayFrom !== storeId ? loadPriceBook(this.db, everydayFrom) : Promise.resolve([]),
      this.db.doc(`watchPrices/${sourceId}`).get(),
    ]);
    const offers: Offer[] = deals.docs.map((d) => {
      const x = d.data();
      const sale = typeof x.salePrice === "number" ? x.salePrice : null;
      return {
        storeId: sourceId,
        storeName: name,
        name: String(x.name ?? ""),
        category: (x.category as Category | undefined) ?? null,
        price: sale,
        regularPrice: typeof x.regularPrice === "number" ? x.regularPrice : null,
        size: (x.size as string | null | undefined) ?? null,
        soldBy: (x.soldBy as string | null | undefined) ?? null,
        onSale: true,
        pctOff: Number(x.pctOff ?? 0) || 0,
        promo: (x.promo as string | null | undefined) ?? null,
        validTo: (x.validTo as string | undefined) ?? null,
      };
    });
    offers.push(...bookOffers(sourceId, name, [...own, ...shared]));
    return { sourceId, name, offers, history: (hist.get("items") as PriceHistory | undefined) ?? {} };
  }
}

/**
 * Adds today's lowest per-lb price for each watch item to watchPrices/{sourceId}, once a day,
 * dropping points older than HISTORY_DAYS. These become "what it usually goes for there".
 */
export async function recordWatchPrices(db: Firestore, store: WatchStore, today: string): Promise<void> {
  const prices = todaysPrices(store.offers).get(store.sourceId);
  if (!prices) return;
  const cutoff = new Date(Date.parse(today) - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const items: PriceHistory = {};
  let changed = false;
  for (const [id, p] of Object.entries(prices)) {
    const old = (store.history[id] ?? []).filter((h) => h.d >= cutoff);
    if (old.some((h) => h.d === today)) { items[id] = old; continue; }
    items[id] = [...old, { d: today, p }];
    changed = true;
  }
  if (!changed) return;
  // Keep items we didn't see today too.
  for (const [id, pts] of Object.entries(store.history)) if (!items[id]) items[id] = pts.filter((h) => h.d >= cutoff);
  store.history = items;
  await db.doc(`watchPrices/${store.sourceId}`).set({ items, updatedAt: new Date().toISOString() });
}
