/**
 * Weekly ad scanning: a shopper photographs one page of a printed weekly ad, Claude reads
 * the deals and the dates they're good for, and the deals go into deals/ like the ones the
 * collectors load. This fills in stores whose ad we can't get automatically (ALDI near El
 * Campo, local grocers). Same single Haiku call as receipt scanning, about a third of a cent.
 *
 * Safety rules, so one photo can't do much harm:
 * - A store whose ad we already load automatically can't be scanned: the feed always wins.
 * - The ad must print dates, it must be good today, and its deals drop off when it ends.
 * - The name on the ad must match the store.
 * - Deals are labeled as coming from a shopper's photo, and a second matching scan
 *   "confirms" them (confirmations).
 * Coupons aren't supported yet (fine print, limits, and they belong to one shopper).
 */
import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { DocumentReference, Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import type { Deal } from "./collectKroger";
import { withStockUp } from "./stockUp";

export const AD_SCAN_MODEL = "claude-haiku-5-5";

/** Deals from shopper photos carry this source, so the app and planner can tell them apart. */
export const SHOPPER_AD = "shopper-ad";

/** Longest an ad can run, counted from today. Weekly ads run 7 days; some run two weeks. */
const MAX_AD_DAYS = 21;

/**
 * Chains whose ads we load automatically. A shopper can't add a new store for these from an
 * ad photo (their stores come from the collectors).
 */
const FEED_CHAINS = /kroger|h-?e-?b\b|walmart|dollar general/i;

const AdSchema = z.object({
  kind: z
    .enum(["weekly-ad", "coupon", "other"])
    .describe("weekly-ad: a store's printed sale flyer or ad page. coupon: a coupon or coupon sheet. other: anything else."),
  storeName: z.string().nullable().describe("The store or chain the ad is for, as printed (e.g. 'ALDI')"),
  validFrom: z.string().nullable().describe("First day the prices are good, YYYY-MM-DD, if printed"),
  validTo: z.string().nullable().describe("Last day the prices are good, YYYY-MM-DD, if printed"),
  items: z.array(
    z.object({
      name: z.string().describe("Plain product name a shopper would recognize, e.g. 'Boneless skinless chicken breasts'"),
      brand: z.string().nullable(),
      size: z.string().nullable().describe("Package size if printed, e.g. '16 oz'"),
      soldBy: z.enum(["UNIT", "WEIGHT"]).describe("WEIGHT when the price is per lb"),
      salePrice: z
        .number()
        .nullable()
        .describe("Sale price for one unit (or per lb). For '2 for $5' give 2.50. Null if the deal has no single price."),
      regularPrice: z
        .number()
        .nullable()
        .describe("Regular price if the ad prints it, or sale price plus 'save $X'. Null if not shown."),
      promo: z
        .string()
        .nullable()
        .describe("Deal wording when it isn't a plain price, e.g. 'Buy 1 get 1 free', '2 for $5', 'Limit 2'. Null otherwise."),
      category: z.enum(["meat", "seafood", "produce", "dairy", "bakery", "pantry", "frozen", "household"]),
    })
  ),
});

function systemPrompt(today: string): string {
  return `You read photos of printed grocery store weekly ads. Today is ${today}.
List every product deal on the page with its price. Skip banners, store hours, recipes, and anything
without a price or deal. Read the dates the ad is good for (e.g. "Prices good Wed 11/12 - Tue 11/18");
when the year isn't printed, use the year that puts the dates nearest today. Only fill dates the ad
actually prints. If the image is a coupon or coupon sheet, set kind to "coupon". If it isn't a
store ad at all, set kind to "other". Non-food items (paper towels, soap, pet food) go in household.`;
}

export interface ScannedDeal {
  name: string;
  brand: string | null;
  size: string | null;
  soldBy: string;
  salePrice: number | null;
  regularPrice: number | null;
  promo: string | null;
  category: Deal["category"];
  /** How many shoppers' scans showed this same deal (1 = just this one). */
  confirmations: number;
}

export interface AdScanResult {
  /** True when this page was already scanned (no reward). */
  duplicate: boolean;
  /** The store the deals were saved under (new when the shopper added a store). */
  storeId: string;
  storeName: string;
  /** True when this scan added the store to Chuckwagon. */
  newStore: boolean;
  validFrom: string | null;
  validTo: string;
  deals: ScannedDeal[];
  inputTokens: number;
  outputTokens: number;
}

/** Thrown for problems the shopper can fix (wrong store, no dates); shown as is. */
export class AdScanError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** True when the name printed on the ad is the same chain as the store ("Aldi" vs "ALDI"). */
export function sameChain(printed: string | null, chain: string): boolean {
  if (!printed) return true; // many ad pages only print the logo on the first page
  const a = letters(printed);
  const b = letters(chain);
  return a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a));
}

/** Store id for a store a shopper adds from an ad: same form as the ad collectors use. */
export function shopperStoreId(chain: string, zip: string): string {
  return `${letters(chain).slice(0, 30)}-${zip}`;
}

/** Where a photo came from: a store we have, or (for a store we don't) the shopper's area and the store's name. */
export interface ScanWhere {
  storeId?: string;
  /** Typed by the shopper when the store isn't in their list. The name printed on the photo wins when there is one. */
  storeName?: string;
  zip?: string;
  lat?: number;
  lng?: number;
}

/** A store a shopper is adding from a photo, found by name near their ZIP (it may already exist). */
export interface ShopperStore {
  ref: DocumentReference;
  storeId: string;
  chain: string;
  /** Set when the store doc doesn't exist yet: what to write with shopperStoreDoc. */
  newStore: { zip: string; lat?: number; lng?: number } | null;
  /** The existing doc's dealsFrom / everydayFrom, if any. */
  dealsFrom?: string;
  everydayFrom?: string;
}

/**
 * The store for a photo from a store that isn't in the shopper's list: named from the photo
 * (or what the shopper typed), near their ZIP. Stores we load automatically are refused, so
 * shoppers pick those from their list instead.
 */
export async function findShopperStore(db: Firestore, printed: string | null, where: ScanWhere, what: "ad" | "receipt"): Promise<ShopperStore> {
  const zip = where.zip ?? "";
  if (!/^\d{5}$/.test(zip)) throw new AdScanError("Set your ZIP code in Settings first.");
  const typed = where.storeName?.replace(/\s+/g, " ").trim() ?? "";
  const name = printed && letters(printed).length >= 2 ? printed : typed;
  if (letters(name).length < 2) {
    throw new AdScanError(
      what === "ad"
        ? "We couldn't find the store's name on this page. Type the store's name, or try the ad's front page."
        : "We couldn't find the store's name on this receipt. Type the store's name and scan it again."
    );
  }
  if (FEED_CHAINS.test(name)) {
    throw new AdScanError(
      what === "ad"
        ? `We already get ${name}'s weekly ad automatically. Pick it from your stores to see the deals.`
        : `${name} is already in Chuckwagon. Pick it from the store list and scan again.`
    );
  }
  const chain = name.replace(/\s+/g, " ").trim().slice(0, 40);
  const storeId = shopperStoreId(chain, zip);
  const ref = db.doc(`stores/${storeId}`);
  const existing = await ref.get();
  return {
    ref,
    storeId,
    chain: existing.exists ? String(existing.get("chain")) : chain,
    newStore: existing.exists ? null : { zip, lat: where.lat, lng: where.lng },
    dealsFrom: existing.exists ? (existing.get("dealsFrom") as string | undefined) : undefined,
    everydayFrom: existing.exists ? (existing.get("everydayFrom") as string | undefined) : undefined,
  };
}

/** The store doc for a store a shopper added from a photo. */
export function shopperStoreDoc(chain: string, at: { zip: string; lat?: number; lng?: number }, uid: string, source: string, now: Timestamp) {
  const { zip, lat, lng } = at;
  return {
    chain,
    name: chain,
    address: { addressLine1: source === SHOPPER_AD ? "Weekly ad from shoppers" : "Prices from shoppers' receipts", city: `near ${zip}`, zipCode: zip },
    zip,
    areaZips: [zip],
    ...(typeof lat === "number" && typeof lng === "number" && lat !== 0 ? { geo: { lat, lng } } : {}),
    source,
    addedBy: uid,
    updatedAt: now,
  };
}

/** Where to save a scan's deals, after checking the shopper picked the right store. */
interface Target {
  storeRef: DocumentReference;
  storeId: string;
  /** Store holding the deals (dealsFrom, else the store itself). */
  dealStoreId: string;
  chain: string;
  newStore: { zip: string; lat?: number; lng?: number } | null;
}

async function findTarget(db: Firestore, printed: string | null, where: ScanWhere): Promise<Target> {
  if (where.storeId) {
    const store = await db.doc(`stores/${where.storeId}`).get();
    if (!store.exists) throw new AdScanError("That store wasn't found.");
    const chain = String(store.get("chain") ?? store.get("name") ?? "");
    if (!sameChain(printed, chain)) {
      throw new AdScanError(`That looks like a ${printed} ad, not ${chain}. Pick ${printed} as the store, or choose "Another store".`);
    }
    const dealStoreId = (store.get("dealsFrom") as string | undefined) ?? where.storeId;
    return { storeRef: store.ref, storeId: where.storeId, dealStoreId, chain, newStore: null };
  }
  // A store we don't have yet: named from the ad (or by the shopper), near their ZIP.
  const found = await findShopperStore(db, printed, where, "ad");
  return {
    storeRef: found.ref,
    storeId: found.storeId,
    dealStoreId: found.dealsFrom ?? found.storeId,
    chain: found.chain,
    newStore: found.newStore,
  };
}

export async function scanAd(
  db: Firestore,
  anthropic: Anthropic,
  uid: string,
  where: ScanWhere,
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/webp",
  today: string
): Promise<AdScanResult> {
  const response = await anthropic.beta.messages.parse({
    model: AD_SCAN_MODEL,
    max_tokens: 8000,
    output_config: { format: betaZodOutputFormat(AdSchema) },
    system: systemPrompt(today),
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: imageBase64 } },
          { type: "text", text: "List the deals on this ad page and the dates they're good for." },
        ],
      },
    ],
  });
  const ad = response.parsed_output;
  if (!ad) throw new AdScanError("Couldn't read that ad. Try a flatter, brighter photo of one page.");
  if (ad.kind === "coupon") throw new AdScanError("Coupons can't be scanned yet. Weekly ad pages work!");
  if (ad.kind !== "weekly-ad") throw new AdScanError("That doesn't look like a store's weekly ad.");

  // Dates: the ad must say when it ends, and be good today.
  const validTo = isDate(ad.validTo) ? ad.validTo : null;
  const validFrom = isDate(ad.validFrom) ? ad.validFrom : null;
  if (!validTo) {
    throw new AdScanError("We couldn't find the dates this ad is good for. Include the part that says when prices end (often at the top or bottom).");
  }
  if (validTo < today) throw new AdScanError(`This ad ended ${validTo}. Scan this week's ad instead.`);
  if (validTo > addDays(today, MAX_AD_DAYS) || (validFrom && validFrom > addDays(today, 7))) {
    throw new AdScanError("The dates on this ad don't look like this week's. Check the photo and try again.");
  }

  const target = await findTarget(db, ad.storeName, where);

  // The automatic feed always wins: don't mix shopper photos into a store we already load.
  // (Collectors replace all of a store's deals each run, so a fed store holds no shopper deals.)
  const some = await db.collection("deals").where("storeId", "==", target.dealStoreId).limit(5).get();
  if (some.docs.some((d) => d.get("source") !== SHOPPER_AD)) {
    throw new AdScanError(`We already get ${target.chain}'s weekly ad automatically, so there's no need to scan it. Thanks though!`);
  }

  const now = Timestamp.now();
  const fresh = ad.items
    .map((it) => {
      const sale = it.salePrice !== null && it.salePrice > 0 && it.salePrice < 500 ? round2(it.salePrice) : null;
      const reg = it.regularPrice !== null && sale !== null && it.regularPrice > sale && it.regularPrice < 1000 ? round2(it.regularPrice) : null;
      const promo = it.promo?.replace(/\s+/g, " ").trim().slice(0, 160) || null;
      return { ...it, name: it.name.replace(/\s+/g, " ").trim().slice(0, 90), salePrice: sale, regularPrice: reg, promo };
    })
    .filter((it) => it.name.length > 1 && (it.salePrice !== null || it.promo !== null))
    // One deal per product: the same item twice on a page keeps the first.
    .filter((it, i, all) => all.findIndex((o) => letters(o.name) === letters(it.name) && letters(o.size ?? "") === letters(it.size ?? "")) === i);
  if (fresh.length === 0) throw new AdScanError("We couldn't read any prices on that page. Try a closer, brighter photo.");

  const dealId = (it: { name: string; size: string | null }) =>
    `${target.dealStoreId}_scan-${createHash("sha256").update(`${letters(it.name)}|${letters(it.size ?? "")}`).digest("hex").slice(0, 16)}`;
  const refs = fresh.map((it) => db.doc(`deals/${dealId(it)}`));

  const deals: ScannedDeal[] = [];
  await db.runTransaction(async (tx) => {
    const old = refs.length ? await tx.getAll(...refs) : [];
    if (target.newStore) tx.set(target.storeRef, shopperStoreDoc(target.chain, target.newStore, uid, SHOPPER_AD, now));
    fresh.forEach((it, i) => {
      const prev = old[i];
      // Another shopper's scan of the same deal at the same price confirms it.
      const same =
        prev?.exists &&
        prev.get("source") === SHOPPER_AD &&
        prev.get("salePrice") === it.salePrice &&
        (prev.get("validTo") as string | undefined) === validTo;
      const scannedBy = same ? [...new Set([...((prev!.get("scannedBy") as string[] | undefined) ?? []), uid])] : [uid];
      const savings = it.regularPrice !== null && it.salePrice !== null ? round2(it.regularPrice - it.salePrice) : null;
      const deal: Deal & { scannedBy: string[]; confirmations: number } = {
        storeId: target.dealStoreId,
        chain: target.chain,
        productId: refs[i].id.slice(target.dealStoreId.length + 1),
        name: it.name,
        brand: it.brand,
        size: it.size,
        soldBy: it.soldBy,
        category: it.category,
        krogerCategories: [],
        imageUrl: null,
        regularPrice: it.regularPrice,
        salePrice: it.salePrice,
        savings,
        pctOff: savings !== null && it.regularPrice ? Math.round((savings / it.regularPrice) * 100) : 0,
        promo: it.promo,
        validTo,
        source: SHOPPER_AD,
        fetchedAt: now,
        scannedBy,
        confirmations: scannedBy.length,
      };
      tx.set(refs[i], withStockUp(deal));
      deals.push({
        name: deal.name,
        brand: deal.brand,
        size: deal.size,
        soldBy: deal.soldBy ?? "UNIT",
        salePrice: deal.salePrice,
        regularPrice: deal.regularPrice,
        promo: deal.promo ?? null,
        category: deal.category,
        confirmations: deal.confirmations,
      });
    });
  });

  // Clear this store's shopper deals whose ad has ended.
  const mine = await db.collection("deals").where("storeId", "==", target.dealStoreId).where("source", "==", SHOPPER_AD).get();
  const old = mine.docs.filter((d) => String(d.get("validTo") ?? "").slice(0, 10) < today);
  if (old.length) {
    const writer = db.bulkWriter();
    old.forEach((d) => writer.delete(d.ref));
    await writer.close();
  }

  // The same page scanned twice (by anyone) earns no second reward.
  const fingerprint = createHash("sha256")
    .update([target.dealStoreId, validTo, ...fresh.map((p) => `${letters(p.name)}:${p.salePrice}`).sort()].join("|"))
    .digest("hex");
  const dupe = await db.collection("adScans").where("fingerprint", "==", fingerprint).limit(1).get();
  // Keep what was read (not the photo) so bad scans can be traced and removed.
  await db.collection("adScans").add({
    uid,
    storeId: target.storeId,
    dealStoreId: target.dealStoreId,
    printedStore: ad.storeName,
    validFrom,
    validTo,
    items: ad.items,
    fingerprint,
    duplicate: !dupe.empty,
    newStore: target.newStore !== null,
    at: now,
  });

  return {
    duplicate: !dupe.empty,
    storeId: target.storeId,
    storeName: target.chain,
    newStore: target.newStore !== null,
    validFrom,
    validTo,
    deals,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}
