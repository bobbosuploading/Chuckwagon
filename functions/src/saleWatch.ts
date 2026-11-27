/**
 * Sale alerts for a shopper's watch list (opt-in, see notifications.ts).
 *
 * Two kinds of alert, both plain rules with no AI so they cost nothing to run:
 *  - "Good sale": a watched item (a ready-made one like pork belly or brisket, or any words the
 *    shopper typed) is on sale at least `pct` percent below its usual price.
 *  - "Make it yourself": a cut on sale makes homemade bacon, ground beef or jerky cost at least
 *    `pct` percent less than buying it ready-made, after trim, cure and drying losses.
 *
 * Usual prices, best source first:
 *  1. The store's own regular price on the deal (Kroger always; H-E-B when the ad or the
 *     monthly H-E-B price book says).
 *  2. Everyday prices in the store's price book (priceBooks/ and receiptPrices/).
 *  3. Prices we've seen for the item at that store before (watchPrices/{storeId}). Built up by
 *     this check each day, so it fills in for H-E-B, where the weekly ad is all we get.
 *  4. A rough typical US price. Only used with a 10-point bigger margin, because regional
 *     prices vary a lot (H-E-B's everyday prices are often below national averages).
 */
import type { Category } from "./config";
import { packAmount } from "./clubPrices";
import type { PriceBookItem } from "./priceBook";
import { words } from "./priceBook";
import { promoPctOff } from "./stockUp";

/** A price seen at a store: a deal from the weekly ad, or an everyday price-book price. */
export interface Offer {
  storeId: string;
  storeName: string;
  name: string;
  category: Category | null;
  /** What it costs now (sale price when on sale). Per lb when soldBy is WEIGHT. */
  price: number | null;
  /** The store's regular price for the same amount, if known. */
  regularPrice: number | null;
  size: string | null;
  soldBy: string | null;
  onSale: boolean;
  pctOff: number;
  promo?: string | null;
  validTo?: string | null;
}

export interface WatchSettings {
  /** Ready-made item ids (WATCH_ITEMS). */
  items: string[];
  /** The shopper's own items, in their words. */
  custom: string[];
  bacon: boolean;
  groundBeef: boolean;
  jerky: boolean;
  /** Smallest saving worth a notification, in percent. */
  pct: number;
}

export const PCT_CHOICES = [20, 25, 30, 40, 50];
export const DEFAULT_PCT = 30;
export const MAX_CUSTOM = 10;
/** Extra margin when the only usual price is the rough typical one. */
const TYPICAL_MARGIN = 10;
/** Prices outside this range per lb are misreads (cents read as dollars and so on). */
const MIN_PER_LB = 0.5;
const MAX_PER_LB = 80;

interface Item {
  id: string;
  label: string;
  match: RegExp;
  not?: RegExp;
  /** Rough typical US regular price per lb (late 2026), the last-resort usual price. */
  typical: number;
  /** Categories it can be in (null price-book categories always pass). Default: meat. */
  categories?: Category[];
  /** Bacon and jerky are smoked or dried by nature; everything else must be raw. */
  allowCooked?: boolean;
}

/** Ready-to-eat products, which aren't the raw cut a shopper is watching for. */
const COOKED = /\b(cooked|precooked|pre-cooked|smoked|pulled|bbq sauce|barbecue sauce|sliced deli|deli|lunch ?meat|jerky|sticks?|bites|burnt ends|seasoned|marinated|frozen meals?)\b/i;

/** Ready-made watch items. Ids are stored on users' settings, so never rename one. */
export const WATCH_ITEMS: Item[] = [
  { id: "pork-belly", label: "Pork belly", match: /\bpork belly\b/i, not: /\bbacon\b|\bslices?\b|\bstrips\b/i, typical: 4.5 },
  { id: "brisket", label: "Brisket", match: /\bbrisket\b/i, not: /\bcorned\b|\bpastrami\b/i, typical: 5.5 },
  { id: "pork-ribs", label: "Pork ribs", match: /\b(spare ?ribs?|baby back|st\.? louis|loin back|back ribs|pork (?:\w+ )?ribs?)\b/i, not: /\briblets?\b|\bcountry\b|\bbeef\b/i, typical: 4.75 },
  { id: "beef-ribs", label: "Beef ribs", match: /\b(beef (?:\w+ )?ribs?|short ribs?|plate ribs?)\b/i, typical: 8.5 },
  { id: "pork-butt", label: "Pork butt (shoulder)", match: /\b(boston butt|pork butt|pork shoulder|picnic (?:roast|shoulder)|shoulder roast)\b/i, not: /\bsteaks?\b/i, typical: 2.75 },
  { id: "chuck-roast", label: "Chuck roast", match: /\bchuck\b.*\broast\b|\bchuck (?:eye|pot roast|roll)\b|\bpot roast\b/i, not: /\bground\b/i, typical: 7.5 },
  { id: "ground-beef", label: "Ground beef", match: /\bground (?:beef|chuck|round|sirloin)\b|\bhamburger meat\b/i, not: /\bpatties\b|\bmeatballs?\b|\bcrumbles\b|\bturkey\b/i, typical: 5.75 },
  { id: "bacon", label: "Bacon", match: /\bbacon\b/i, not: /\bturkey\b|\bbits\b|\bpieces\b|\bwrapped\b|\bcheddar\b|\branch\b|\bjam\b|\bprecooked\b|\bfully cooked\b|\bmicrowave\b/i, typical: 7.0, allowCooked: true },
  { id: "tri-tip", label: "Tri-tip", match: /\btri-? ?tip\b/i, typical: 9.0 },
  { id: "whole-chicken", label: "Whole chicken", match: /\bwhole (?:fryer )?chickens?\b|\bfryers?\b/i, not: /\brotisserie\b/i, typical: 2.0 },
  { id: "chicken-thighs", label: "Chicken thighs", match: /\bchicken thighs?\b|\bthighs?\b.*\bchicken\b/i, typical: 2.75 },
  { id: "pork-loin", label: "Pork loin", match: /\bpork loin\b/i, not: /\bchops?\b|\bribs?\b/i, typical: 3.0 },
];

interface Cut {
  id: string;
  label: string;
  match: RegExp;
  not?: RegExp;
  /** Pounds you end up with per raw pound bought (after trim, curing or drying). */
  yield: number;
  /** For ground beef: lean cuts compare with lean ground beef. */
  lean?: boolean;
}

interface Diy {
  key: "bacon" | "groundBeef" | "jerky";
  product: string;
  cuts: Cut[];
  /** Cure, smoke wood, marinade and so on, in dollars per finished lb. */
  extras: number;
  /** What it's compared with: the store-bought product. */
  store: Item;
  storeLean?: Item;
}

const BELLY: Cut = { id: "pork-belly", label: "pork belly", match: /\bpork belly\b/i, not: /\bbacon\b|\bslices?\b|\bstrips\b/i, yield: 0.85 };
const ROUND = /\b(eye of round|bottom round|top round|round roast|rump roast|london broil)\b/i;
const SIRLOIN_TIP = /\bsirloin tip\b/i;

export const DIY: Diy[] = [
  {
    key: "bacon",
    product: "bacon",
    // Skin-off belly loses about 15% curing and smoking. Skin-on loses the skin too (see cutYield).
    cuts: [BELLY],
    extras: 0.25,
    store: WATCH_ITEMS.find((i) => i.id === "bacon")!,
  },
  {
    key: "groundBeef",
    product: "ground beef",
    cuts: [
      // Close to 80/20 as is, barely any trim.
      { id: "chuck", label: "chuck roast", match: /\bchuck\b/i, not: /\bground\b|\bsteaks?\b|\bshort ribs?\b/i, yield: 0.92 },
      // The hard fat cap comes off, about a fifth of a whole packer. Grinds to about 80/20.
      { id: "brisket", label: "brisket", match: /\bbrisket\b/i, not: /\bcorned\b|\bpastrami\b/i, yield: 0.8 },
      { id: "sirloin", label: "sirloin", match: /\bsirloin\b/i, not: /\bground\b|\bpork\b/i, yield: 0.95, lean: true },
      { id: "round", label: "round roast", match: ROUND, not: /\bground\b|\bsteaks?\b/i, yield: 0.95, lean: true },
    ],
    extras: 0,
    store: { id: "ground-regular", label: "ground beef", match: /\bground (?:beef|chuck)\b|\bhamburger meat\b/i, not: /\bpatties\b|\bmeatballs?\b|\bcrumbles\b|\bturkey\b|\bsirloin\b|\bround\b/i, typical: 5.75 },
    storeLean: { id: "ground-lean", label: "lean ground beef", match: /\bground (?:beef|round|sirloin)\b/i, not: /\bpatties\b|\bmeatballs?\b|\bcrumbles\b|\bturkey\b/i, typical: 7.5 },
  },
  {
    key: "jerky",
    product: "jerky",
    // A little trim, then drying takes about 60% of the weight: roughly 2.7 lb raw per lb of jerky.
    cuts: [
      { id: "round", label: "round roast", match: ROUND, not: /\bground\b/i, yield: 0.37 },
      { id: "flank", label: "flank steak", match: /\bflank\b/i, yield: 0.37 },
      { id: "sirloin-tip", label: "sirloin tip", match: SIRLOIN_TIP, not: /\bground\b/i, yield: 0.37 },
    ],
    extras: 1.0,
    store: { id: "jerky", label: "beef jerky", match: /\bbeef jerky\b|\bjerky\b.*\bbeef\b/i, not: /\bsticks?\b|\bdog\b|\bpet\b|\bturkey\b|\bpork\b/i, typical: 30, categories: ["meat", "pantry"], allowCooked: true },
  },
];

const round2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pounds in the offer, 1 for per-lb prices, or null when the size can't be read. */
function pounds(o: Pick<Offer, "name" | "size" | "soldBy">): number | null {
  if (o.soldBy === "WEIGHT") return 1;
  const text = `${o.size ?? ""} ${o.name}`;
  const pack = packAmount(text);
  if (pack?.unit === "lb" && pack.amount > 0) return pack.amount;
  // Ads print "per lb" or just "lb" for meat sold by weight.
  if (!pack && /(^|\s|\/|,)(per\s+)?lbs?\.?(\s|$)/i.test(text)) return 1;
  return null;
}

/** Price per lb now, and the regular price per lb (from the offer itself), if they can be worked out. */
export function perLb(o: Offer): { now: number | null; regular: number | null } {
  const lb = pounds(o);
  if (!lb) return { now: null, regular: null };
  const ok = (n: number | null) => {
    if (n === null) return null;
    const v = n / lb;
    return v >= MIN_PER_LB && v <= MAX_PER_LB ? round2(v) : null;
  };
  return { now: ok(o.price), regular: o.regularPrice && o.price && o.regularPrice > o.price ? ok(o.regularPrice) : null };
}

function matches(item: { match: RegExp; not?: RegExp; categories?: Category[]; allowCooked?: boolean }, o: Offer): boolean {
  const cats = item.categories ?? ["meat"];
  if (o.category && !cats.includes(o.category)) return false;
  const text = `${o.name} ${o.size ?? ""}`;
  if (!item.allowCooked && COOKED.test(text)) return false;
  return item.match.test(text) && !(item.not?.test(text) ?? false);
}

/** A shopper's own item matches when every word they typed is in the product name. */
export function customMatches(text: string, o: Offer): boolean {
  const want = words(text);
  if (!want.length) return false;
  const have = new Set(words(`${o.name} ${o.size ?? ""}`));
  return want.every((w) => have.has(w));
}

/** Percent off the offer says (its regular price, or a buy-one-get-one promo). */
function statedPctOff(o: Offer): number {
  return Math.max(o.pctOff ?? 0, promoPctOff(o.promo)?.pct ?? 0);
}

/** Lowest per-lb price seen for each ready-made item at each store today: saved as history. */
export function todaysPrices(offers: Offer[]): Map<string, Record<string, number>> {
  const out = new Map<string, Record<string, number>>();
  for (const o of offers) {
    const now = perLb(o).now;
    if (now === null) continue;
    for (const item of WATCH_ITEMS) {
      if (!matches(item, o)) continue;
      const rec = out.get(o.storeId) ?? {};
      if (rec[item.id] === undefined || now < rec[item.id]) rec[item.id] = now;
      out.set(o.storeId, rec);
    }
  }
  return out;
}

/** watchPrices/{storeId}.items: { itemId: [{ d: "YYYY-MM-DD", p: price per lb }] } */
export type PriceHistory = Record<string, { d: string; p: number }[]>;
export const HISTORY_DAYS = 120;
const HISTORY_MIN_POINTS = 3;

export interface Usual {
  perLb: number;
  basis: "store" | "price book" | "past prices" | "typical";
}

/** The usual per-lb price of an item at a store (see the sources at the top of this file). */
export function usualPerLb(item: Item, offer: Offer, book: Offer[], history: PriceHistory | undefined, today: string): Usual {
  const own = perLb(offer).regular;
  if (own) return { perLb: own, basis: "store" };
  const everyday = book
    .filter((b) => b.storeId === offer.storeId && matches(item, b))
    .map((b) => perLb({ ...b, price: b.regularPrice ?? b.price }).now)
    .filter((n): n is number => n !== null);
  if (everyday.length) return { perLb: round2(median(everyday)), basis: "price book" };
  const past = (history?.[item.id] ?? []).filter((h) => h.d < today).map((h) => h.p);
  if (past.length >= HISTORY_MIN_POINTS) return { perLb: round2(median(past)), basis: "past prices" };
  return { perLb: item.typical, basis: "typical" };
}

export interface WatchHit {
  /** Stable id so the same sale isn't announced twice. */
  key: string;
  kind: "sale" | "diy";
  /** What the shopper watches: "Pork belly", "Homemade bacon". */
  label: string;
  storeId: string;
  storeName: string;
  product: string;
  /** Sale price per lb, or the package price when per lb is unknown. */
  price: number | null;
  perLb: boolean;
  /** Percent saved: off the usual price, or homemade vs store-bought. */
  pct: number;
  basis: Usual["basis"] | "promo" | "store-bought";
  /** One short line for the notification and the app. */
  line: string;
  validTo: string | null;
  /** True when it passes the shopper's threshold (the app also shows near misses). */
  alert: boolean;
}

const money = (n: number) => `$${n.toFixed(2)}`;

function saleHit(label: string, id: string, o: Offer, book: Offer[], histories: Map<string, PriceHistory>, today: string,
  pct: number, item?: Item): WatchHit | null {
  const lb = perLb(o).now;
  const stated = statedPctOff(o);
  let saved = stated;
  let basis: WatchHit["basis"] = o.regularPrice ? "store" : "promo";
  let needed = pct;
  if (item && lb !== null) {
    const usual = usualPerLb(item, o, book, histories.get(o.storeId), today);
    const vsUsual = Math.round((1 - lb / usual.perLb) * 100);
    if (usual.basis !== "store" && (stated === 0 || vsUsual > stated)) {
      saved = vsUsual;
      basis = usual.basis;
      if (usual.basis === "typical") needed = pct + TYPICAL_MARGIN;
    }
  }
  if (saved <= 0) return null;
  const priceText = lb !== null ? `${money(lb)}/lb` : o.price !== null ? money(o.price) : "on sale";
  const off = basis === "typical" ? `${saved}% below the usual price around the country`
    : basis === "past prices" ? `${saved}% below what it usually goes for there`
    : basis === "price book" ? `${saved}% below its everyday price there`
    : `${saved}% off`;
  return {
    key: `sale:${id}:${o.storeId}:${lb ?? o.price ?? ""}`,
    kind: "sale",
    label,
    storeId: o.storeId,
    storeName: o.storeName,
    product: o.name,
    price: lb ?? o.price,
    perLb: lb !== null,
    pct: saved,
    basis,
    line: `${label} ${priceText} at ${o.storeName} (${off})`,
    validTo: o.validTo ?? null,
    alert: saved >= needed,
  };
}

/** Skin-on belly also loses the skin (about 12% more). */
function cutYield(cut: Cut, o: Offer): number {
  return cut === BELLY && /\bskin[- ]?on\b|\brind\b/i.test(`${o.name} ${o.size ?? ""}`) ? cut.yield - 0.12 : cut.yield;
}

/** Ground beef leanness from "80/20", "93% lean" or the cut's name. */
function isLeanGround(name: string): boolean {
  const ratio = name.match(/\b(\d{2})\s*%?\s*\/\s*(\d{1,2})\b/) ?? name.match(/\b(\d{2})\s*%\s*lean\b/i);
  if (ratio) return Number(ratio[1]) >= 88;
  return /\b(lean|sirloin|round)\b/i.test(name);
}

function diyHits(diy: Diy, sales: Offer[], all: Offer[], pct: number): WatchHit[] {
  // Store-bought price: the cheapest per lb at the shopper's stores right now, sale or not.
  const storePrice = (item: Item, lean?: boolean): { perLb: number; seen: boolean } => {
    const prices = all
      .filter((o) => matches(item, o) && (lean === undefined || isLeanGround(o.name) === lean))
      .map((o) => perLb(o).now)
      .filter((n): n is number => n !== null);
    return prices.length ? { perLb: Math.min(...prices), seen: true } : { perLb: item.typical, seen: false };
  };
  const label = `Homemade ${diy.product}`;
  let best: WatchHit | null = null;
  for (const cut of diy.cuts) {
    for (const o of sales) {
      if (!matches({ match: cut.match, not: cut.not }, o)) continue;
      const lb = perLb(o).now;
      if (lb === null) continue;
      const cost = round2(lb / cutYield(cut, o) + diy.extras);
      const compareItem = cut.lean && diy.storeLean ? diy.storeLean : diy.store;
      const compare = storePrice(compareItem, diy.key === "groundBeef" ? !!cut.lean : undefined);
      const saved = Math.round((1 - cost / compare.perLb) * 100);
      if (saved <= 0 || (best && saved <= best.pct)) continue;
      const name = compareItem.label.toLowerCase();
      const vs = compare.seen ? `store ${name} (${money(compare.perLb)}/lb)` : `${name} at a typical ${money(compare.perLb)}/lb`;
      best = {
        key: `diy:${diy.key}:${cut.id}:${o.storeId}:${lb}`,
        kind: "diy",
        label,
        storeId: o.storeId,
        storeName: o.storeName,
        product: o.name,
        price: lb,
        perLb: true,
        pct: saved,
        basis: "store-bought",
        line: `${label}: ${cut.label} ${money(lb)}/lb at ${o.storeName} works out to about ${money(cost)}/lb, ${saved}% less than ${vs}`,
        validTo: o.validTo ?? null,
        alert: saved >= (compare.seen ? pct : pct + TYPICAL_MARGIN),
      };
    }
  }
  return best ? [best] : [];
}

/**
 * Everything on the watch list that's on sale now, best saving first. `offers` holds deals and
 * price-book items for the shopper's stores; price-book items with a promo count as on sale.
 * Only the best offer per watched item is returned. `alert` says whether it passes `pct`.
 */
export function checkWatchList(settings: WatchSettings, offers: Offer[], histories: Map<string, PriceHistory>, today: string): WatchHit[] {
  const live = offers.filter((o) => !o.validTo || o.validTo.slice(0, 10) >= today);
  const sales = live.filter((o) => o.onSale);
  const book = live.filter((o) => !o.onSale);
  const hits: WatchHit[] = [];
  const bestOf = (cands: (WatchHit | null)[]) =>
    cands.filter((h): h is WatchHit => !!h).sort((a, b) => Number(b.alert) - Number(a.alert) || b.pct - a.pct)[0];

  for (const id of settings.items) {
    const item = WATCH_ITEMS.find((i) => i.id === id);
    if (!item) continue;
    const best = bestOf(sales.filter((o) => matches(item, o)).map((o) => saleHit(item.label, item.id, o, book, histories, today, settings.pct, item)));
    if (best) hits.push(best);
  }
  for (const text of settings.custom) {
    const label = text.trim().replace(/^\w/, (c) => c.toUpperCase());
    const best = bestOf(sales.filter((o) => customMatches(text, o)).map((o) => saleHit(label, `custom-${words(text).join("-")}`, o, book, histories, today, settings.pct)));
    if (best) hits.push(best);
  }
  for (const diy of DIY) {
    if (settings[diy.key]) hits.push(...diyHits(diy, sales, live, settings.pct));
  }
  return hits.sort((a, b) => Number(b.alert) - Number(a.alert) || b.pct - a.pct);
}

/** Cleans settings sent by the app. */
export function cleanWatchSettings(raw: unknown): WatchSettings {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ids = new Set(WATCH_ITEMS.map((i) => i.id));
  const items = (Array.isArray(d.items) ? d.items : []).filter((s): s is string => typeof s === "string" && ids.has(s));
  const custom = (Array.isArray(d.custom) ? d.custom : [])
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.replace(/\s+/g, " ").trim().slice(0, 40))
    .filter((s) => words(s).length > 0)
    .slice(0, MAX_CUSTOM);
  const pct = PCT_CHOICES.includes(Number(d.pct)) ? Number(d.pct) : DEFAULT_PCT;
  return { items: [...new Set(items)], custom: [...new Set(custom)], bacon: d.bacon === true, groundBeef: d.groundBeef === true, jerky: d.jerky === true, pct };
}

export function watchIsOn(w: WatchSettings | undefined): boolean {
  return !!w && (w.items.length > 0 || w.custom.length > 0 || w.bacon || w.groundBeef || w.jerky);
}

/** Price-book items as offers (on sale when they carry a current promo). */
export function bookOffers(storeId: string, storeName: string, items: PriceBookItem[]): Offer[] {
  return items.map((p) => {
    const onSale = !!p.promo && p.promo < p.price;
    return {
      storeId, storeName, name: p.name, category: p.category, size: p.size, soldBy: p.soldBy,
      price: onSale ? p.promo! : p.price,
      regularPrice: p.price,
      onSale,
      pctOff: onSale ? Math.round((1 - p.promo! / p.price) * 100) : 0,
    };
  });
}

/** The notification for a run's hits that pass the threshold. */
export function watchMessage(hits: WatchHit[]): { title: string; body: string } {
  const first = hits[0];
  const title = hits.length === 1
    ? (first.kind === "diy" ? `${first.label} is worth making this week` : `${first.label} is on sale`)
    : `${hits.length} things on your watch list are on sale`;
  const body = hits.slice(0, 3).map((h) => h.line).join(". ") + (hits.length > 3 ? `. And ${hits.length - 3} more.` : ".");
  return { title, body: body.slice(0, 600) };
}
