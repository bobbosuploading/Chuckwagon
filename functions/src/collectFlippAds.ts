import { getFirestore, Timestamp } from "firebase-admin/firestore";
import type { Deal } from "./collectKroger";
import { withStockUp } from "./stockUp";
import { toHebDeal } from "./collectHeb";
import { AD_MAX_REGIONS } from "./config";
import { clearOwnDeals, markAreasReady, sharingFields } from "./regions";

/**
 * Weekly ads for chains that have no public API (ALDI, Dollar General), read from Flipp
 * the same way as the H-E-B ad (see collectHeb.ts). Ads list sale prices and promo text;
 * everyday prices come from shoppers' receipts instead (see receipts.ts).
 * Before a paid launch this should move to a licensed data source.
 */
const FLIPP = "https://backflipp.wishabi.com/flipp";
const UA = "Mozilla/5.0 (compatible; Chuckwagon/0.1)";

export interface AdChain {
  /** Store id prefix: stores/{key}-{zip} */
  key: string;
  chain: string;
  /** Matches Flipp's merchant name. */
  merchant: RegExp;
}

export const AD_CHAINS: AdChain[] = [
  // ALDI was not on Flipp near 77437 (Nov 2026), so it loads nothing there for now.
  { key: "aldi", chain: "ALDI", merchant: /^aldi\b/i },
  { key: "dollargeneral", chain: "Dollar General", merchant: /dollar general/i },
];

interface FlippFlyer { id: number; merchant: string; name?: string; valid_from: string; valid_to: string }

/**
 * Dollar General's ad is mostly non-food. These go to "household" so the meal planner
 * never sees them; drinks and coffee go to "pantry" (the H-E-B word list would call
 * "Dr Pepper" produce and "ground coffee" meat).
 */
const NON_FOOD = /holiday|ornament|gift|greeting card|tissue paper|bows\b|lights|tree topper|stocking|plush|tees\b|napkin|plates|plastic cups|paper cups|cutlery|batter(y|ies)|mobile|samsung|phone|vitamin|zinc|mucinex|delsym|biofreeze|toothpaste|colgate|body wash|soap|deodorant|shampoo|lotion|cleaner|febreze|detergent|laundry|fabric softener|beauty|stp\b|motor|pet food|cat food|dog food|cat litter|dog treats|toy/i;
const DRINKS = /coffee|soda|cola|dr pepper|7up|sunkist|canada dry|a&w|mountain dew|pepsi|coke|sprite|gatorade|water\b|juice|tea\b|beer|budweiser|bud light|coors|miller|michelob|wine/i;

function adCategory(name: string, fallback: Deal["category"]): Deal["category"] {
  if (NON_FOOD.test(name)) return "household";
  if (DRINKS.test(name)) return "pantry";
  return fallback;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export interface AdSummary {
  chain: string;
  /** Store holding the deals (the first area that got these flyers). */
  storeId: string;
  /** Other areas with the same flyers; their store docs point at storeId. */
  sharedWith: string[];
  flyers: { id: number; name?: string; validFrom: string; validTo: string }[];
  deals: number;
  removed: number;
}

/**
 * Load the current weekly ads for each chain, for every area ZIP. Areas that get the same
 * flyers share one copy of the deals (see regions.ts): only the first such area's store holds
 * them, and the others point at it. With dryRun, nothing is written.
 */
export async function collectFlippAds(zips: string[], chains = AD_CHAINS, dryRun = false) {
  const nowMs = Date.now();
  const flyersByZip = new Map<string, FlippFlyer[]>();
  for (const zip of zips) {
    try {
      const res = await getJson<FlippFlyer[] | { flyers: FlippFlyer[] }>(`${FLIPP}/flyers?locale=en-us&postal_code=${zip}`);
      flyersByZip.set(zip, Array.isArray(res) ? res : res.flyers);
    } catch (err) {
      console.warn(`Flipp flyers near ${zip}: ${(err as Error).message}`);
    }
  }
  const merchantsSeen = [...new Set([...flyersByZip.values()].flat().map((f) => f.merchant))].sort();
  const results: { summary: AdSummary; deals: Deal[] }[] = [];
  const db = dryRun ? null : getFirestore();
  const covered: string[] = [];

  for (const c of chains) {
    const byKey = new Map<string, { summary: AdSummary; deals: Deal[] }>();
    for (const zip of zips) {
      // A chain can have more than one current flyer (weekly ad plus a seasonal one); read them all.
      const flyers = (flyersByZip.get(zip) ?? [])
        .filter((f) => c.merchant.test(f.merchant))
        .filter((f) => Date.parse(f.valid_from) <= nowMs && nowMs <= Date.parse(f.valid_to))
        .sort((a, b) => a.id - b.id);
      if (flyers.length === 0) continue;
      const key = flyers.map((f) => f.id).join(",");
      const storeId = `${c.key}-${zip}`;
      const now = Timestamp.now();
      const storeDoc = {
        chain: c.chain,
        name: c.chain,
        address: { addressLine1: "Weekly ad", city: `near ${zip}`, zipCode: zip },
        zip,
        source: "flipp",
        updatedAt: now,
      };

      const known = byKey.get(key);
      if (known) {
        known.summary.sharedWith.push(zip);
        if (!db || known.deals.length === 0) continue;
        const sourceZip = known.summary.storeId.slice(c.key.length + 1);
        await db.doc(`stores/${storeId}`).set({
          ...storeDoc,
          ...sharingFields({
            dealsFrom: known.summary.storeId,
            everydayFrom: known.summary.storeId,
            note: `Same weekly ad as ${c.chain} near ${sourceZip}.`,
          }),
        }, { merge: true });
        await clearOwnDeals(db, storeId);
        covered.push(zip);
        continue;
      }
      if (byKey.size >= AD_MAX_REGIONS) {
        console.warn(`${c.chain}: more than ${AD_MAX_REGIONS} different ads; skipping ${zip} this run`);
        continue;
      }

      const byName = new Map<string, Deal>();
      for (const f of flyers) {
        const flyer = await getJson<{ items: { id: number }[] }>(`${FLIPP}/flyers/${f.id}?locale=en-us`);
        for (const { id } of flyer.items) {
          try {
            const { item } = await getJson<{ item: Parameters<typeof toHebDeal>[0] }>(`${FLIPP}/items/${id}?locale=en-us`);
            if (!item?.name) continue;
            const base = toHebDeal(item, storeId, now);
            const deal: Deal = { ...base, chain: c.chain, category: adCategory(base.name, base.category) };
            // Skip ad tiles with no price and no promo (banners, "see store for details").
            if (deal.salePrice === null && !deal.promo) continue;
            const k = deal.name.toLowerCase();
            if (!byName.has(k)) byName.set(k, deal);
          } catch (err) {
            console.warn(`${c.chain} item ${id}: ${(err as Error).message}`);
          }
          await new Promise((r) => setTimeout(r, 250)); // be polite
        }
      }
      const deals = [...byName.values()];
      const summary: AdSummary = {
        chain: c.chain,
        storeId,
        sharedWith: [],
        flyers: flyers.map((f) => ({ id: f.id, name: f.name, validFrom: f.valid_from, validTo: f.valid_to })),
        deals: deals.length,
        removed: 0,
      };
      const result = { summary, deals };
      byKey.set(key, result);
      results.push(result);
      if (!db || deals.length === 0) continue;

      const writer = db.bulkWriter();
      writer.set(db.doc(`stores/${storeId}`), {
        ...storeDoc,
        ...sharingFields({ dealsFrom: null, everydayFrom: null, note: null }),
      }, { merge: true });
      for (const d of deals) writer.set(db.doc(`deals/${storeId}_${d.productId}`), withStockUp(d));
      await writer.flush();
      const stale = await db.collection("deals").where("storeId", "==", storeId).where("fetchedAt", "<", now).get();
      stale.forEach((d) => writer.delete(d.ref));
      summary.removed = stale.size;
      await writer.close();
      covered.push(zip);
      await db.collection("runs").add({ type: `ad-${c.key}`, zip, at: now, ...summary });
    }
  }
  if (db) await markAreasReady(db, covered);
  return { merchantsSeen, results };
}
