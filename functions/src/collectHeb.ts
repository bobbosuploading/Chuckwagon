import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { AD_MAX_REGIONS, Category } from "./config";
import type { Deal } from "./collectKroger";
import { clearOwnDeals, markAreasReady, sharingFields } from "./regions";
import { withStockUp } from "./stockUp";
import { enrichHebDeals } from "./hebPrices";

/**
 * H-E-B has no public API. For testing we read the weekly ad as published on Flipp,
 * which lists each ad item with its price or promo text. No regular prices are given,
 * so savings are known only when the ad states them ("SAVE $2.38").
 * Before a paid launch this should move to a licensed data source.
 */
const FLIPP = "https://backflipp.wishabi.com/flipp";
const UA = "Mozilla/5.0 (compatible; Chuckwagon/0.1)";

interface FlippFlyer { id: number; merchant: string; valid_from: string; valid_to: string }
interface FlippItem {
  id: number;
  name: string;
  brand: string | null;
  description: string | null;
  price_text: string | null;
  sale_story: string | null;
  disclaimer_text: string | null;
  current_price: string | null;
  dollars_off: number | null;
  percent_off: number | null;
  cutout_image_url: string | null;
  valid_to: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Keyword sort into our categories. "household" is never used for meals. */
const CATEGORY_WORDS: [Category, RegExp][] = [
  ["household", /detergent|laundry|tide|gain|oral care|crest|toothbrush|hair|server|flatware|foil pan|pans\b|paper towel|toilet|cleaner|diaper|huggies|pull-ups|shampoo|soap|batter(y|ies)|slow cooker|tableware|mystery box|cookware|clorox/i],
  ["pantry", /chips|bars\b|fruit snacks|gushers|cereal|pasta|crackers|cookies|candy|soda/i],
  ["seafood", /shrimp|salmon|trout|tilapia|fish|crab|catfish|cod|tuna steak|scallop/i],
  ["frozen", /frozen|ice cream|pizza rolls|french fries/i],
  ["meat", /beef|chuck|steak|pork|chicken|turkey|ham\b|sausage|bacon|brisket|ribs|ground|tamales|wings|thighs|drumsticks/i],
  ["dairy", /cheese|milk|yogurt|butter|cream cheese|sour cream|eggs|charcuterie/i],
  ["bakery", /bakery|bread|pie|tortilla|buns|rolls|cake|muffin/i],
  ["produce", /apple|pear|grapefruit|mango|tomato|potato|onion|pepper|avocado|lettuce|banana|orange|grape|berr|squash|carrot|celery|broccoli|fresh/i],
];

function categorize(text: string): Category {
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat;
  return "pantry";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function toHebDeal(it: FlippItem, storeId: string, now: Timestamp): Deal {
  const price = it.current_price ? Number(it.current_price) : NaN;
  const salePrice = Number.isFinite(price) && price > 0 ? price : null;
  const savings = it.dollars_off ?? null;
  const regularPrice = salePrice !== null && savings !== null ? round2(salePrice + savings) : null;
  const pctOff = it.percent_off ?? (regularPrice && savings ? Math.round((savings / regularPrice) * 100) : 0);
  const promo = [it.sale_story, it.disclaimer_text].filter(Boolean).join(" ").replace(/\s+/g, " ").trim() || null;
  return {
    storeId,
    chain: "H-E-B",
    productId: `flipp-${it.id}`,
    name: it.name,
    brand: it.brand,
    size: it.description?.replace(/\s+/g, " ").trim() || null,
    soldBy: /lb/i.test(it.price_text ?? "") ? "WEIGHT" : "UNIT",
    category: categorize(`${it.name} ${it.description ?? ""}`),
    krogerCategories: [],
    imageUrl: it.cutout_image_url?.replace(/^http:/, "https:") ?? null,
    regularPrice,
    salePrice,
    savings,
    pctOff,
    promo,
    validTo: it.valid_to,
    source: "flipp",
    fetchedAt: now,
  };
}

/** The H-E-B weekly ad valid today for `zip`, or null if Flipp has none there. */
async function currentHebFlyer(zip: string): Promise<FlippFlyer | null> {
  const flyers = await getJson<FlippFlyer[] | { flyers: FlippFlyer[] }>(`${FLIPP}/flyers?locale=en-us&postal_code=${zip}`);
  const list = Array.isArray(flyers) ? flyers : flyers.flyers;
  const nowMs = Date.now();
  return list
    .filter((f) => f.merchant === "H-E-B")
    .filter((f) => Date.parse(f.valid_from) <= nowMs && nowMs <= Date.parse(f.valid_to))
    .sort((a, b) => Date.parse(b.valid_from) - Date.parse(a.valid_from))[0] ?? null;
}

export interface HebRegion {
  flyerId: number;
  /** The area whose store doc holds this flyer's deals. */
  sourceZip: string;
  /** Other areas that get the same flyer and show the source's deals. */
  sharedWith: string[];
  validFrom: string;
  validTo: string;
  deals: number;
  removed: number;
  /** Ad items given a regular price from the H-E-B price book. */
  regularPricesAdded?: number;
}

/**
 * Loads the H-E-B weekly ad for every area. H-E-B runs one ad per region and Flipp gives every
 * ZIP in a region the same flyer, so each flyer is read once: the first area that gets it holds
 * the deals (heb-{zip}), and other areas with that flyer point at it (dealsFrom).
 * Everyday prices come from the one monthly Apify run (priceBooks/heb-{everydayZip}) for every area.
 * With dryRun, nothing is written.
 */
export async function collectHebDeals(zips: string[], dryRun = false, everydayZip = zips[0]) {
  const db = dryRun ? null : getFirestore();
  const now = Timestamp.now();
  const regions = new Map<number, HebRegion>();
  const dealsByFlyer = new Map<number, Deal[]>();
  const noAd: string[] = [];
  const overCap: string[] = [];
  const everydayId = `heb-${everydayZip}`;
  const everydayName =
    ((await db?.doc(`priceBooks/${everydayId}`).get())?.get("storeName") as string | undefined) ?? `H-E-B near ${everydayZip}`;

  for (const zip of zips) {
    const flyer = await currentHebFlyer(zip).catch((err) => {
      console.warn(`H-E-B flyers near ${zip}: ${(err as Error).message}`);
      return null;
    });
    if (!flyer) {
      noAd.push(zip);
      continue;
    }
    const storeId = `heb-${zip}`;
    const known = regions.get(flyer.id);
    const everyday = zip === everydayZip ? null : everydayId;

    if (known) {
      known.sharedWith.push(zip);
      if (!db) continue;
      await db.doc(`stores/${storeId}`).set({
        chain: "H-E-B",
        name: "H-E-B",
        address: { addressLine1: "Weekly ad", city: `near ${zip}`, zipCode: zip },
        zip,
        source: "flipp",
        updatedAt: now,
        ...sharingFields({
          dealsFrom: `heb-${known.sourceZip}`,
          everydayFrom: everyday,
          note: `Same weekly ad as H-E-B near ${known.sourceZip}. Everyday prices from ${everydayName}.`,
        }),
      }, { merge: true });
      await clearOwnDeals(db, storeId);
      continue;
    }
    if (regions.size >= AD_MAX_REGIONS) {
      overCap.push(zip);
      continue;
    }

    const items = await getJson<{ items: { id: number }[] }>(`${FLIPP}/flyers/${flyer.id}?locale=en-us`);
    const deals: Deal[] = [];
    for (const { id } of items.items) {
      const { item } = await getJson<{ item: FlippItem }>(`${FLIPP}/items/${id}?locale=en-us`);
      deals.push(withStockUp(toHebDeal(item, storeId, now)));
      await new Promise((r) => setTimeout(r, 250)); // be polite
    }
    const region: HebRegion = {
      flyerId: flyer.id, sourceZip: zip, sharedWith: [], validFrom: flyer.valid_from, validTo: flyer.valid_to,
      deals: deals.length, removed: 0,
    };
    regions.set(flyer.id, region);
    dealsByFlyer.set(flyer.id, deals);
    if (!db) continue;

    const writer = db.bulkWriter();
    writer.set(db.doc(`stores/${storeId}`), {
      chain: "H-E-B",
      name: "H-E-B",
      address: { addressLine1: "Weekly ad", city: `near ${zip}`, zipCode: zip },
      zip,
      source: "flipp",
      updatedAt: now,
      ...sharingFields({
        dealsFrom: null,
        everydayFrom: everyday,
        note: everyday ? `Everyday prices from ${everydayName}.` : null,
      }),
    }, { merge: true });
    for (const d of deals) writer.set(db.doc(`deals/${storeId}_${d.productId}`), d);
    await writer.flush();
    const stale = await db.collection("deals").where("storeId", "==", storeId).where("fetchedAt", "<", now).get();
    stale.forEach((d) => writer.delete(d.ref));
    region.removed = stale.size;
    await writer.close();
    // Fill in regular prices (and savings) from the H-E-B price book, when there is one.
    region.regularPricesAdded = (await enrichHebDeals(db, storeId, everydayId)).enriched;
  }

  const summary = {
    areas: zips,
    regions: [...regions.values()],
    deals: [...regions.values()].reduce((t, r) => t + r.deals, 0),
    noAd,
    overCap,
  };
  if (db) {
    await markAreasReady(db, [...regions.values()].flatMap((r) => [r.sourceZip, ...r.sharedWith]));
    await db.collection("runs").add({ type: "heb", zip: zips[0], at: now, ...summary });
  }
  // Deals for the first (home) region, for the dry-run printout.
  const first = [...regions.values()][0];
  return { summary, deals: first ? dealsByFlyer.get(first.flyerId) ?? [] : [] };
}
