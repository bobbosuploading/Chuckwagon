/**
 * Sam's Club "stock-up trip": a monthly list of bulk staples and how their price per pound
 * (or per count) compares with the grocery stores we already track.
 *
 * Sam's Club has no public price feed, so prices come from a third-party Apify scraper
 * (https://apify.com/123webdata/sams-club-scraper) reading samsclub.com search pages. These
 * are website prices, the same for every club. Like H-E-B's scraper this is for the beta only:
 * turn it off (SAMS_PRICES_ENABLED=false) before a paid launch.
 *
 * Cost: about $0.89 per 1,000 list rows plus $0.02 per run. One run a month of at most
 * SAMS_MAX_ITEMS rows, capped at SAMS_MAX_CHARGE_USD, fits in what the H-E-B run leaves of
 * Apify's free $5.
 *
 * Saved to clubLists/sams (read by the app) and priceBooks/sams-club (receipts and plans).
 */
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { getFirestore } from "firebase-admin/firestore";
import { z } from "zod";
import type { Category } from "./config";
import { PriceBookItem, shortlist } from "./priceBook";
import { MATCH_MODEL } from "./priceItems";
import { keepRule } from "./stockUp";

const ACTOR = "123webdata~sams-club-scraper";
const API = "https://api.apify.com/v2";
export const SAMS_MAX_ITEMS = 320;
export const SAMS_MAX_CHARGE_USD = 0.45;
/** Sam's has to beat the best grocery price by this much to count as worth the trip. */
const WORTH_IT_PCT = 10;

/** Bulk staples that keep (freezer or pantry). One samsclub.com search each. */
export const SAMS_TERMS: Record<Exclude<Category, "household" | "produce">, string[]> = {
  meat: ["chicken breast", "chicken thighs", "ground beef", "pork loin", "bacon", "smoked sausage", "ground turkey", "beef roast"],
  seafood: ["frozen shrimp", "frozen salmon", "tilapia"],
  dairy: ["butter", "shredded cheese", "eggs"],
  bakery: ["flour tortillas"],
  pantry: ["rice", "pinto beans", "pasta", "flour", "sugar", "vegetable oil", "olive oil", "peanut butter", "canned tomatoes", "chicken broth", "oats", "coffee"],
  frozen: ["frozen vegetables", "frozen fruit"],
};

/** What we read from a scraper row. Field names vary a little, so several are tried. */
interface SamsRow {
  url?: string;
  product_id?: string;
  name?: string;
  title?: string;
  price?: number | string | null;
  regular_price?: number | string | null;
  unit_price?: string | null;
  main_image?: string | null;
  image?: string | null;
  in_stock?: boolean | null;
  source_url?: string | null;
  [key: string]: unknown;
}

export type UnitBasis = "lb" | "ct" | "floz";

/** One row of the stock-up list. */
export interface ClubItem {
  name: string;
  category: Category;
  price: number;
  /** Price per lb, per count or per fl oz. */
  unitPrice: number;
  unit: UnitBasis;
  /** How much is in the pack, in `unit`s. */
  amount: number;
  imageUrl: string | null;
  url: string | null;
  /** "freezer", "pantry" or "fridge", with how to store it. Null when it doesn't keep. */
  keep: string | null;
  storage: string | null;
  /** The cheapest matching product at each grocery chain, same unit. */
  compare: { chain: string; product: string; unitPrice: number }[];
  /** Percent cheaper than the best grocery price (negative when Sam's costs more). Null with nothing to compare. */
  pctCheaper: number | null;
  worthIt: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[^0-9.]/g, "")) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * How much is in a pack, read from its name or size text: "6 lbs", "2 pk., 48 oz. each",
 * "36 ct", "12 x 15 oz", "Avg. 3.1 lbs", "1 gal". Weight wins over count, so chicken
 * sold as "6 lb, 3 pk" compares per lb. Null when nothing can be read.
 */
export function packAmount(text: string): { unit: UnitBasis; amount: number } | null {
  const t = text.toLowerCase().replace(/,/g, " ");
  const multi =
    t.match(/(\d+)\s*(?:x|pk\.?|pack|ct\.?|count)\s*(?:of|x|\/|-)?\s*(\d+(?:\.\d+)?)\s*-?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?)/) ??
    null;
  const multiAfter = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?)\.?\s*(?:each)?\s*[ (]*\s*(\d+)\s*(?:pk|pack|ct|count)/);
  const single = t.match(/(\d+(?:\.\d+)?)\s*-?\s*(fl\.?\s*oz|oz|ounces?|lbs?|pounds?|gal(?:lon)?s?|qt|quarts?|l(?:iters?)?\b)/);
  const weigh = (n: number, u: string, times = 1): { unit: UnitBasis; amount: number } | null => {
    const unit = u.replace(/[.\s]/g, "");
    if (unit.startsWith("floz")) return { unit: "floz", amount: n * times };
    if (unit.startsWith("gal")) return { unit: "floz", amount: n * 128 * times };
    if (unit.startsWith("q")) return { unit: "floz", amount: n * 32 * times };
    if (unit === "l" || unit.startsWith("liter")) return { unit: "floz", amount: round3(n * 33.8 * times) };
    if (unit.startsWith("oz") || unit.startsWith("ounce")) return { unit: "lb", amount: round3((n * times) / 16) };
    if (unit.startsWith("lb") || unit.startsWith("pound")) return { unit: "lb", amount: n * times };
    return null;
  };
  if (multi) return weigh(Number(multi[2]), multi[3], Number(multi[1]));
  if (multiAfter) return weigh(Number(multiAfter[1]), multiAfter[2], Number(multiAfter[3]));
  if (single) return weigh(Number(single[1]), single[2]);
  const count = t.match(/(\d+)\s*(?:ct\.?|count|pk\.?|pack|eggs|rolls)\b/);
  if (count) return { unit: "ct", amount: Number(count[1]) };
  const dozen = t.match(/(\d+)\s*dozen/);
  if (dozen) return { unit: "ct", amount: Number(dozen[1]) * 12 };
  return null;
}

/** Price per lb / count / fl oz for a grocery price book item, or null when the size can't be read. */
export function bookUnitPrice(p: PriceBookItem): { unit: UnitBasis; unitPrice: number } | null {
  if (p.soldBy === "WEIGHT") return { unit: "lb", unitPrice: p.price };
  const pack = packAmount(`${p.size ?? ""} ${p.name}`);
  if (!pack || pack.amount <= 0) return null;
  return { unit: pack.unit, unitPrice: p.price / pack.amount };
}

async function apify<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`Apify ${path} -> HTTP ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** One scraper run over the search pages for `terms`, at most `maxItems` rows in all. */
async function runScraper(token: string, terms: string[], maxItems: number): Promise<SamsRow[]> {
  const input = {
    productUrls: [],
    categoryUrls: terms.map((t) => `https://www.samsclub.com/search?q=${encodeURIComponent(t)}`),
    maxResultsPerScrape: maxItems,
    usePagination: false,
    scrapeProductDetails: false,
  };
  const charge = Math.min(SAMS_MAX_CHARGE_USD, Math.ceil(maxItems * 0.00089 * 100 + 4) / 100);
  const started = await apify<{ data: { id: string; defaultDatasetId: string } }>(
    token,
    `/acts/${ACTOR}/runs?maxItems=${maxItems}&maxTotalChargeUsd=${charge}`,
    { method: "POST", body: JSON.stringify(input) }
  );
  const runId = started.data.id;
  for (let waited = 0; ; waited += 60) {
    const run = await apify<{ data: { status: string } }>(token, `/actor-runs/${runId}?waitForFinish=60`);
    const status = run.data.status;
    if (status === "SUCCEEDED") break;
    if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
      console.warn(`Apify run ${runId} ended ${status}; using what it saved`);
      break;
    }
    if (waited > 40 * 60) throw new Error(`Apify run ${runId} still ${status} after 40 minutes`);
  }
  const res = await fetch(`${API}/datasets/${started.data.defaultDatasetId}/items?clean=true&format=json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Apify dataset -> HTTP ${res.status}`);
  return (await res.json()) as SamsRow[];
}

/** Which of our staples a product is, from the search it came from or its name. */
function termFor(row: SamsRow, name: string): { category: Category; term: string } | null {
  const from = decodeURIComponent(String(row.source_url ?? row.list_url ?? row.category_url ?? row.search_url ?? "")).toLowerCase();
  const lower = name.toLowerCase();
  let byName: { category: Category; term: string } | null = null;
  for (const [category, terms] of Object.entries(SAMS_TERMS) as [Category, string[]][]) {
    for (const term of terms) {
      if (from.includes(`q=${term}`) || from.includes(`q=${term.replace(/ /g, "+")}`)) return { category, term };
      if (!byName && term.split(" ").every((w) => lower.includes(w.replace(/s$/, "")))) byName = { category, term };
    }
  }
  return byName;
}

const PickSchema = z.object({
  picks: z.array(
    z.object({
      item: z.number().int().describe("The ITEM number"),
      same: z.array(z.string()).describe("Letters of the grocery products that are the same food"),
    })
  ),
});

const SYSTEM = `You compare warehouse-club products with grocery store products so their unit prices can be compared.
For each ITEM, list the letters of the grocery products that are the same food in a comparable form and quality,
so a shopper could buy either one for the same use. Pack size and brand may differ. The form must match:
raw vs cooked, boneless vs bone-in, fresh or frozen plain vs breaded or seasoned, whole bean vs instant, and so on.
Never match a different food that shares a word. Return an empty list when none fits.`;

/** Asks Haiku which grocery products are the same food as each club item. */
async function matchToGrocery(
  anthropic: Anthropic,
  items: { name: string; unit: UnitBasis }[],
  books: Map<string, PriceBookItem[]>
): Promise<{ chain: string; product: string; unitPrice: number }[][]> {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const out: { chain: string; product: string; unitPrice: number }[][] = items.map(() => []);
  const BATCH = 40;
  for (let start = 0; start < items.length; start += BATCH) {
    const lines: string[] = [];
    const options = new Map<number, { chain: string; p: PriceBookItem; unitPrice: number }[]>();
    items.slice(start, start + BATCH).forEach((it, k) => {
      const i = start + k;
      const cands: { chain: string; p: PriceBookItem; unitPrice: number }[] = [];
      for (const [chain, book] of books) {
        for (const p of shortlist(it.name, book, 12)) {
          const u = bookUnitPrice(p);
          if (u && u.unit === it.unit && cands.filter((c) => c.chain === chain).length < 5) {
            cands.push({ chain, p, unitPrice: u.unitPrice });
          }
        }
      }
      if (!cands.length) return;
      options.set(i, cands.slice(0, letters.length));
      lines.push(`ITEM ${i + 1}: ${it.name}`);
      options.get(i)!.forEach((c, j) => lines.push(`  ${letters[j]}) ${c.p.name}${c.p.size ? ` | ${c.p.size}` : ""}`));
    });
    if (!lines.length) continue;
    const response = await anthropic.beta.messages.parse({
      model: MATCH_MODEL,
      max_tokens: 4000,
      output_config: { format: betaZodOutputFormat(PickSchema) },
      system: SYSTEM,
      messages: [{ role: "user", content: lines.join("\n") }],
    });
    for (const pick of response.parsed_output?.picks ?? []) {
      const cands = options.get(pick.item - 1);
      if (!cands) continue;
      const best = new Map<string, { chain: string; product: string; unitPrice: number }>();
      for (const letter of pick.same) {
        const c = cands[letters.indexOf(letter.trim().toLowerCase())];
        if (!c) continue;
        const had = best.get(c.chain);
        if (!had || c.unitPrice < had.unitPrice) {
          best.set(c.chain, { chain: c.chain, product: c.p.name, unitPrice: round3(c.unitPrice) });
        }
      }
      out[pick.item - 1] = [...best.values()].sort((a, b) => a.unitPrice - b.unitPrice);
    }
  }
  return out;
}

/** Every grocery chain's everyday prices (collector books and receipts), keyed by chain name. */
async function groceryBooks(): Promise<Map<string, PriceBookItem[]>> {
  const db = getFirestore();
  const books = new Map<string, PriceBookItem[]>();
  for (const coll of ["priceBooks", "receiptPrices"]) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      if (doc.id.startsWith("sams-")) continue;
      const chain = (doc.get("chain") as string | undefined) ?? doc.id.split("-")[0];
      const name = /^h-?e-?b$/i.test(chain) ? "H-E-B" : chain.charAt(0).toUpperCase() + chain.slice(1).toLowerCase();
      const items = ((doc.get("items") as PriceBookItem[] | undefined) ?? []).map((p) => ({ ...p, promo: null }));
      books.set(name, [...(books.get(name) ?? []), ...items]);
    }
  }
  return books;
}

export async function collectSamsClub(
  token: string,
  anthropic: Anthropic | null,
  opts: { dryRun?: boolean; maxItems?: number; terms?: string[] } = {}
) {
  const maxItems = Math.min(opts.maxItems ?? SAMS_MAX_ITEMS, SAMS_MAX_ITEMS);
  const terms = opts.terms ?? Object.values(SAMS_TERMS).flat();
  const rows = await runScraper(token, terms, maxItems);

  const seen = new Set<string>();
  const parsed: Omit<ClubItem, "compare" | "pctCheaper" | "worthIt">[] = [];
  for (const r of rows) {
    const name = String(r.name ?? r.title ?? "").replace(/\s+/g, " ").trim();
    const price = num(r.price);
    if (!name || !price || r.in_stock === false) continue;
    const key = String(r.product_id ?? r.url ?? name);
    if (seen.has(key)) continue;
    seen.add(key);
    const what = termFor(r, name);
    // The site's own unit price wins when it is per lb or per fl oz ("$5.29/lb"); meat that is
    // "priced per pound" has no size in its name, and its price is for an average pack.
    const attrs = (r.attributes ?? {}) as Record<string, unknown>;
    const listed = String(attrs["Unit price"] ?? r.unit_price ?? "").toLowerCase().match(/\$?(\d+(?:\.\d+)?)\s*\/\s*(lb|fl\.? ?oz)/);
    const listedPrice = listed ? Number(listed[1]) : 0;
    const pack =
      listedPrice > 0
        ? { unit: (listed![2] === "lb" ? "lb" : "floz") as UnitBasis, amount: round3(price / listedPrice) }
        : packAmount(name);
    if (!what || !pack || pack.amount <= 0) continue;
    const rule = keepRule(name, what.category);
    parsed.push({
      name: name.slice(0, 110),
      category: what.category,
      price,
      unitPrice: round3(price / pack.amount),
      unit: pack.unit,
      amount: pack.amount,
      imageUrl: (r.main_image ?? r.image ?? null) as string | null,
      url: (r.url ?? null) as string | null,
      keep: rule?.keep ?? null,
      storage: rule?.storage || null,
    });
  }

  const summary = { rows: rows.length, items: parsed.length, compared: 0, worthIt: 0, saved: false };
  if (opts.dryRun || !anthropic || parsed.length === 0) {
    return { summary, items: parsed.map((p) => ({ ...p, compare: [], pctCheaper: null, worthIt: false })) as ClubItem[], rows };
  }

  const matches = await matchToGrocery(anthropic, parsed, await groceryBooks());
  const items: ClubItem[] = parsed.map((p, i) => {
    const compare = matches[i];
    const best = compare[0]?.unitPrice;
    const pctCheaper = best ? Math.round(((best - p.unitPrice) / best) * 100) : null;
    return { ...p, compare, pctCheaper, worthIt: pctCheaper !== null && pctCheaper >= WORTH_IT_PCT };
  });
  summary.compared = items.filter((i) => i.compare.length).length;
  summary.worthIt = items.filter((i) => i.worthIt).length;

  const db = getFirestore();
  const now = new Date().toISOString();
  await db.doc("clubLists/sams").set({
    chain: "Sam's Club",
    updatedAt: now,
    source: "samsclub.com",
    // Only items with a grocery price to compare (this also drops search results that aren't
    // the staple we looked for). Best buys first.
    items: items.filter((i) => i.pctCheaper !== null).sort((a, b) => (b.pctCheaper ?? 0) - (a.pctCheaper ?? 0)),
  });
  const book: PriceBookItem[] = items.map((i) => ({
    name: i.name,
    size: null,
    price: i.price,
    promo: null,
    soldBy: "UNIT",
    category: i.category,
    source: "sams-apify",
    seenAt: now.slice(0, 10),
  }));
  await db.doc("priceBooks/sams-club").set({ storeId: "sams-club", chain: "Sam's Club", items: book, updatedAt: now, source: "sams-apify" });
  summary.saved = true;
  await db.collection("runs").add({ type: "sams-club", at: new Date(), ...summary });
  return { summary, items, rows };
}
