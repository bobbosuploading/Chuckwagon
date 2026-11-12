/**
 * Price regions: how Chuckwagon covers more areas without pulling more data.
 *
 * Grocery chains price by region. Every Kroger in a division runs the same weekly ad and
 * nearly the same shelf prices, and every H-E-B that gets the same Flipp flyer runs the same
 * ad. So for each chain we fully collect ONE store per region (the "source" store) and give
 * every other nearby store a pointer to it:
 *
 *   stores/{id}.dealsFrom      store whose deals this store shows (absent = its own)
 *   stores/{id}.everydayFrom   store whose everyday prices it uses (absent = its own)
 *   stores/{id}.pricesNote     what the app shows, e.g. "Prices from Kroger, Sugar Land (14 mi away)"
 *
 * Shoppers still see their own nearest stores; the label says where the prices come from.
 * Areas are the ZIPs shoppers registered (areas/{zip}, see registerArea in index.ts).
 */
import { FieldValue, Firestore } from "firebase-admin/firestore";

/** ZIPs to collect for: the home ZIP first, then registered areas (oldest first). Waitlisted areas are skipped. */
export async function loadAreaZips(db: Firestore | null, homeZip: string): Promise<string[]> {
  const fromEnv = process.env.AREA_ZIPS?.split(",").map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z));
  if (fromEnv?.length) return [...new Set([homeZip, ...fromEnv])];
  if (!db) return [homeZip];
  try {
    const snap = await db.collection("areas").where("status", "in", ["ready", "pending"]).get();
    const zips = snap.docs
      .map((d) => ({ zip: d.id, at: (d.get("createdAt") as string | undefined) ?? "" }))
      .sort((a, b) => a.at.localeCompare(b.at))
      .map((a) => a.zip);
    return [...new Set([homeZip, ...zips])];
  } catch (err) {
    console.warn(`Couldn't read areas, collecting the home ZIP only: ${(err as Error).message}`);
    return [homeZip];
  }
}

/** Marks pending areas ready once a collector has saved at least one store for them. */
export async function markAreasReady(db: Firestore, zips: Iterable<string>): Promise<void> {
  for (const zip of new Set(zips)) {
    const ref = db.collection("areas").doc(zip);
    const snap = await ref.get();
    if (snap.exists && snap.get("status") === "pending") {
      await ref.update({ status: "ready", readyAt: new Date().toISOString() });
    }
  }
}

/** Store doc fields saying where its prices come from. Clears them for a store that has its own. */
export function sharingFields(share: { dealsFrom?: string | null; everydayFrom?: string | null; note?: string | null }) {
  return {
    dealsFrom: share.dealsFrom ?? FieldValue.delete(),
    everydayFrom: share.everydayFrom ?? FieldValue.delete(),
    pricesNote: share.note ?? FieldValue.delete(),
  };
}

/** Same as sharingFields, for a doc written with set() (no merge), where delete sentinels aren't allowed. */
export function sharingFieldsForSet(share: { dealsFrom?: string | null; everydayFrom?: string | null; note?: string | null }) {
  return {
    ...(share.dealsFrom ? { dealsFrom: share.dealsFrom } : {}),
    ...(share.everydayFrom ? { everydayFrom: share.everydayFrom } : {}),
    ...(share.note ? { pricesNote: share.note } : {}),
  };
}

/**
 * Deletes deals saved under a store that now borrows another store's deals
 * (it used to be a source store), so they don't linger after the sale ends.
 */
export async function clearOwnDeals(db: Firestore, storeId: string): Promise<number> {
  const snap = await db.collection("deals").where("storeId", "==", storeId).get();
  if (snap.empty) return 0;
  const writer = db.bulkWriter();
  snap.forEach((d) => writer.delete(d.ref));
  await writer.close();
  return snap.size;
}

/** Miles between two points (haversine). */
export function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = 3958.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface RegionStore {
  id: string;
  chain: string;
  /** Pricing region within the chain when known (Kroger division). */
  division?: string | null;
  geo?: { lat: number; lng: number } | null;
}

export interface RegionPlan<T extends RegionStore> {
  /** Stores collected in full, in order. */
  sources: T[];
  /** Stores that borrow a source store's prices. */
  borrowers: { store: T; from: T; miles: number | null }[];
  /** Stores left out because the source cap was reached and nothing nearby could share. */
  skipped: T[];
}

/**
 * Picks source stores greedily, in the order given (home area first, nearest first):
 * a store borrows from an earlier source of the same chain and division within `shareMiles`;
 * otherwise it becomes a source, up to `maxSources`. Past the cap, it borrows from the
 * nearest same-chain source within `stretchMiles`, or is skipped.
 */
export function planRegions<T extends RegionStore>(
  stores: T[],
  opts: { shareMiles: number; maxSources: number; stretchMiles: number }
): RegionPlan<T> {
  const plan: RegionPlan<T> = { sources: [], borrowers: [], skipped: [] };
  const distance = (a: T, b: T) => (a.geo && b.geo ? milesBetween(a.geo, b.geo) : null);
  const sameRegion = (a: T, b: T) => a.chain === b.chain && (!a.division || !b.division || a.division === b.division);
  const nearest = (s: T, ok: (src: T) => boolean, within: number) => {
    let best: { from: T; miles: number | null } | null = null;
    for (const src of plan.sources) {
      if (!ok(src)) continue;
      const d = distance(s, src);
      if (d !== null && d > within) continue;
      if (!best || (d ?? Infinity) < (best.miles ?? Infinity)) best = { from: src, miles: d };
    }
    return best;
  };
  for (const s of stores) {
    const near = nearest(s, (src) => sameRegion(s, src), opts.shareMiles);
    if (near) {
      plan.borrowers.push({ store: s, ...near });
      continue;
    }
    if (plan.sources.length < opts.maxSources) {
      plan.sources.push(s);
      continue;
    }
    const stretch = nearest(s, (src) => src.chain === s.chain, opts.stretchMiles);
    if (stretch) plan.borrowers.push({ store: s, ...stretch });
    else plan.skipped.push(s);
  }
  return plan;
}
