import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { Category } from "./config";
import type { Deal } from "./collectKroger";
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

/** Load the H-E-B weekly ad that is valid today near `zip`. With dryRun, nothing is written. */
export async function collectHebDeals(zip: string, dryRun = false) {
  const flyers = await getJson<FlippFlyer[] | { flyers: FlippFlyer[] }>(`${FLIPP}/flyers?locale=en-us&postal_code=${zip}`);
  const list = Array.isArray(flyers) ? flyers : flyers.flyers;
  const nowMs = Date.now();
  const heb = list
    .filter((f) => f.merchant === "H-E-B")
    .filter((f) => Date.parse(f.valid_from) <= nowMs && nowMs <= Date.parse(f.valid_to))
    .sort((a, b) => Date.parse(b.valid_from) - Date.parse(a.valid_from))[0];
  if (!heb) throw new Error(`No current H-E-B weekly ad near ${zip}`);

  const flyer = await getJson<{ items: { id: number }[] }>(`${FLIPP}/flyers/${heb.id}?locale=en-us`);
  const now = Timestamp.now();
  const storeId = `heb-${zip}`;
  const deals: Deal[] = [];
  for (const { id } of flyer.items) {
    const { item } = await getJson<{ item: FlippItem }>(`${FLIPP}/items/${id}?locale=en-us`);
    deals.push(withStockUp(toHebDeal(item, storeId, now)));
    await new Promise((r) => setTimeout(r, 250)); // be polite
  }

  const summary = { flyerId: heb.id, validFrom: heb.valid_from, validTo: heb.valid_to, deals: deals.length, removed: 0 };
  if (dryRun) return { summary, deals };

  const db = getFirestore();
  const writer = db.bulkWriter();
  writer.set(db.doc(`stores/${storeId}`), {
    chain: "H-E-B",
    name: "H-E-B",
    address: { addressLine1: "Weekly ad", city: `near ${zip}`, zipCode: zip },
    source: "flipp",
    updatedAt: now,
  }, { merge: true });
  for (const d of deals) writer.set(db.doc(`deals/${storeId}_${d.productId}`), d);
  await writer.flush();
  const stale = await db.collection("deals").where("storeId", "==", storeId).where("fetchedAt", "<", now).get();
  stale.forEach((d) => writer.delete(d.ref));
  summary.removed = stale.size;
  await writer.close();
  // Fill in regular prices (and savings) from the H-E-B price book, when there is one.
  const priced = await enrichHebDeals(db, zip);
  await db.collection("runs").add({ type: "heb", zip, at: now, ...summary, regularPricesAdded: priced.enriched });
  return { summary, deals };
}
