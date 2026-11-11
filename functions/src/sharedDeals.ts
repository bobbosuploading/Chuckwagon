/**
 * "Share a deal": a shopper sees a grocery deal on Facebook, TikTok, Reddit, a deal blog or a
 * text from a friend, and shares it into Chuckwagon (a screenshot, a link, or the post's text).
 * Haiku reads the deal (about a third of a cent) and it shows up at the shopper's store, marked
 * "spotted by a shopper", until it expires or shoppers say it's gone.
 *
 * Social deals are often one store's clearance, short-lived, or already gone, so:
 * - They live in sharedDeals/, not deals/. The collectors replace a store's deals/ on every run,
 *   and shared deals sit beside the feed instead of fighting it (Walmart deals can be shared).
 * - Each one belongs to one store, or to every store of a chain when the post says it's
 *   nationwide or online ("scope").
 * - They expire on the end date the post gives, else after a few days (clearance sooner).
 * - Other shoppers tap "Still there" (keeps it a few more days) or "Gone" (two more "Gone"
 *   than "Still there" hides it).
 * - Posts more than two weeks old are refused.
 * We keep what was read and the link, never the screenshot.
 */
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaContentBlockParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Firestore, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { sameChain } from "./adScans";
import type { Deal } from "./collectKroger";

export const SHARE_MODEL = "claude-haiku-5-5";

/** Days a shared deal shows when the post gives no end date. */
export const SHARE_DAYS = { deal: 5, clearance: 3, stillThere: 3 } as const;
/** Longest end date we accept, counted from today. */
const MAX_DAYS = 21;
/** Posts older than this are refused: the deal is probably gone. */
const MAX_POST_AGE_DAYS = 14;

const ShareSchema = z.object({
  kind: z
    .enum(["deal", "not-a-deal"])
    .describe("deal: a post, screenshot or page about a sale, price drop, clearance, rollback or freebie at a store. not-a-deal: anything else."),
  storeName: z.string().nullable().describe("The store or chain the deal is at, e.g. 'Walmart', 'H-E-B'. Null if not said."),
  scope: z
    .enum(["one-store", "chain", "unknown"])
    .describe("chain: the post says it's nationwide, online, in the weekly ad, or at all stores. one-store: a single store's clearance or a find at a specific location. unknown: not clear."),
  clearance: z.boolean().describe("True for clearance, markdowns, 'hidden' deals, penny items or anything that varies by store."),
  postedDate: z.string().nullable().describe("When the post was made, YYYY-MM-DD, only if a date is visible. Relative times like '3d' count back from today."),
  validTo: z.string().nullable().describe("Last day the deal is good, YYYY-MM-DD, only if the post says."),
  items: z
    .array(
      z.object({
        name: z.string().describe("Plain product name a shopper would recognize, e.g. 'Great Value whole milk'"),
        brand: z.string().nullable(),
        size: z.string().nullable(),
        soldBy: z.enum(["UNIT", "WEIGHT"]).describe("WEIGHT when the price is per lb"),
        salePrice: z.number().nullable().describe("Deal price for one unit (or per lb). For '2 for $5' give 2.50. Null if there's no single price."),
        regularPrice: z.number().nullable().describe("Usual price if the post says it or shows a 'was' price. Null otherwise."),
        promo: z.string().nullable().describe("Deal wording when it isn't a plain price, e.g. 'Buy 1 get 1 free', 'Clearance, 50% off'. Null otherwise."),
        category: z.enum(["meat", "seafood", "produce", "dairy", "bakery", "pantry", "frozen", "household"]),
      })
    )
    .describe("Each product deal in the post, at most 10. Groceries and household essentials only."),
});

function systemPrompt(today: string): string {
  return `You read grocery deals that shoppers share from social media, deal sites and messages:
screenshots of Facebook, Instagram, TikTok, Reddit or X posts, deal blog pages, or plain text. Today is ${today}.
List each grocery or household product deal (food, drinks, paper towels, toilet paper, soap, diapers, pet food)
with its price. Skip electronics, clothing, toys and furniture. Skip comments, ads for other things,
and anything without a price or a deal. Only fill dates the post actually shows; when the year isn't
shown, use the year that puts the date nearest today. Non-food items go in household.
If there's no grocery or household deal, set kind to "not-a-deal".`;
}

export interface SharedDealOut {
  id: string;
  name: string;
  brand: string | null;
  size: string | null;
  soldBy: string;
  salePrice: number | null;
  regularPrice: number | null;
  promo: string | null;
  category: Deal["category"];
  /** True when another shopper already shared this same deal. */
  alreadyShared: boolean;
}

export interface ShareResult {
  storeId: string;
  storeName: string;
  /** "one-store" or "chain" (shows at every store of the chain). */
  scope: "one-store" | "chain";
  clearance: boolean;
  validTo: string;
  /** True when the end date came from the post, false when it's our default. */
  endDateFromPost: boolean;
  deals: SharedDealOut[];
  inputTokens: number;
  outputTokens: number;
}

/** Problems the shopper can fix (wrong store, old post); shown as is. */
export class ShareError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;
export const chainKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const isDate = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------
// Links: most social posts need a login, so we only read the page's title and preview text
// (what a link preview shows). The shopper's own text and screenshots matter more.

/** True for addresses on the public internet (not this server, the cloud's metadata server or a private network). */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    return true;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === "::" || low === "::1") return false;
    if (low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return false;
    const mapped = low.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicAddress(mapped[1]);
    return true;
  }
  return false;
}

/** Only https on the normal port, to a named host. */
export function allowedUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) return null;
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) || !url.hostname.includes(".")) return null;
  if (/(^|\.)(internal|local|localhost)$/i.test(url.hostname)) return null;
  return url;
}

/** One GET that connects only to a public address (checked at connect time) and reads at most 1 MB. */
function getOnce(url: URL): Promise<{ status: number; location?: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        timeout: 6000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ChuckwagonLinkPreview/1.0)", Accept: "text/html" },
        lookup: (host, _opts, cb) => {
          lookup(host, { all: true })
            .then((addrs) => {
              const ok = addrs.find((a) => isPublicAddress(a.address));
              if (!ok || addrs.some((a) => !isPublicAddress(a.address))) cb(new Error("blocked address"), "", 4);
              else cb(null, ok.address, ok.family);
            })
            .catch((e) => cb(e, "", 4));
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location: res.headers.location, body: "" });
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > 1_000_000) {
            req.destroy();
            resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
          } else chunks.push(c);
        });
        res.on("end", () => resolve({ status, body: Buffer.concat(chunks).toString("utf8") }));
        res.on("error", reject);
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

const decode = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** The title, preview text and some page text, the way a link preview reads it. */
export function previewText(html: string): string {
  const meta = (name: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, "i");
    const tag = html.match(re)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    return content ? decode(content) : "";
  };
  const title = meta("og:title") || decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  const description = meta("og:description") || meta("description") || meta("twitter:description");
  const body = decode(
    html
      .replace(/<(script|style|noscript|svg|nav|header|footer)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  ).slice(0, 6000);
  return [title && `Title: ${title}`, description && `Preview: ${description}`, body && `Page text: ${body}`].filter(Boolean).join("\n");
}

/** Reads a shared link's preview. Returns "" when the page can't be read (login walls, errors). */
export async function readLink(raw: string): Promise<string> {
  let url = allowedUrl(raw);
  for (let hop = 0; url && hop < 4; hop++) {
    try {
      const res = await getOnce(url);
      if (res.location) {
        url = allowedUrl(new URL(res.location, url).toString());
        continue;
      }
      return res.status >= 200 && res.status < 300 ? previewText(res.body) : "";
    } catch {
      return "";
    }
  }
  return "";
}

// ---------------------------------------------------------------------------------------------

export interface ShareInput {
  /** The shopper's store this deal is at. */
  storeId: string;
  imageBase64?: string;
  mediaType?: "image/jpeg" | "image/png" | "image/webp";
  url?: string;
  text?: string;
}

/** Firestore id for a shared deal: the same product and price at the same place shares one. */
export function sharedDealId(place: string, it: { name: string; size: string | null; salePrice: number | null; promo: string | null }): string {
  const key = [place, chainKey(it.name), chainKey(it.size ?? ""), it.salePrice ?? chainKey(it.promo ?? "")].join("|");
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

export async function shareDeal(db: Firestore, anthropic: Anthropic, uid: string, input: ShareInput, today: string): Promise<ShareResult> {
  const storeDoc = await db.doc(`stores/${input.storeId}`).get();
  if (!storeDoc.exists) throw new ShareError("That store wasn't found.");
  const chain = String(storeDoc.get("chain") ?? storeDoc.get("name") ?? "");
  const storeName = String(storeDoc.get("name") ?? chain);

  const url = input.url?.trim() ? allowedUrl(input.url.trim())?.toString() ?? null : null;
  const linkText = url ? await readLink(url) : "";
  const text = (input.text ?? "").trim().slice(0, 4000);
  if (!input.imageBase64 && !text && !linkText) {
    throw new ShareError(
      url
        ? "We couldn't open that link (many social posts need a login). Share a screenshot of the post instead."
        : "Share a screenshot, a link or the post's text."
    );
  }

  const content: BetaContentBlockParam[] = [];
  if (input.imageBase64) {
    content.push({ type: "image", source: { type: "base64", media_type: input.mediaType ?? "image/jpeg", data: input.imageBase64 } });
  }
  const parts = [
    `The shopper says this deal is at: ${chain}.`,
    url ? `Shared link: ${url}` : "",
    linkText ? `From the linked page:\n${linkText}` : "",
    text ? `Text the shopper shared:\n${text}` : "",
    "List the grocery deals in this post.",
  ];
  content.push({ type: "text", text: parts.filter(Boolean).join("\n\n") });

  const response = await anthropic.beta.messages.parse({
    model: SHARE_MODEL,
    max_tokens: 3000,
    output_config: { format: betaZodOutputFormat(ShareSchema) },
    system: systemPrompt(today),
    messages: [{ role: "user", content }],
  });
  const post = response.parsed_output;
  if (!post || post.kind !== "deal") {
    throw new ShareError("We couldn't find a grocery deal with a price in that. Try a screenshot that shows the item and price.");
  }
  if (post.storeName && !sameChain(post.storeName, chain)) {
    throw new ShareError(`That deal looks like it's at ${post.storeName}, not ${chain}. Pick ${post.storeName} as the store if it's one of yours.`);
  }
  if (isDate(post.postedDate) && post.postedDate < addDays(today, -MAX_POST_AGE_DAYS)) {
    throw new ShareError(`That post is from ${post.postedDate}. Deals that old are usually gone, so we didn't add it.`);
  }

  // Dates: the post's end date if it gives a believable one, else a short default.
  let validTo: string;
  let endDateFromPost = false;
  if (isDate(post.validTo)) {
    if (post.validTo < today) throw new ShareError(`That deal ended ${post.validTo}.`);
    if (post.validTo > addDays(today, MAX_DAYS)) throw new ShareError("The dates on that deal don't look right. Check the post and try again.");
    validTo = post.validTo;
    endDateFromPost = true;
  } else {
    validTo = addDays(today, post.clearance ? SHARE_DAYS.clearance : SHARE_DAYS.deal);
  }
  // Clearance always belongs to one store; otherwise trust a clear "nationwide/online".
  const scope: "one-store" | "chain" = !post.clearance && post.scope === "chain" ? "chain" : "one-store";
  const key = chainKey(chain);
  const place = scope === "chain" ? `chain:${key}` : `store:${input.storeId}`;

  const items = post.items
    .slice(0, 10)
    .map((it) => {
      const sale = it.salePrice !== null && it.salePrice > 0 && it.salePrice < 500 ? round2(it.salePrice) : null;
      const reg = it.regularPrice !== null && sale !== null && it.regularPrice > sale && it.regularPrice < 1000 ? round2(it.regularPrice) : null;
      const promo = it.promo?.replace(/\s+/g, " ").trim().slice(0, 160) || null;
      return { ...it, name: it.name.replace(/\s+/g, " ").trim().slice(0, 90), salePrice: sale, regularPrice: reg, promo };
    })
    .filter((it) => it.name.length > 1 && (it.salePrice !== null || it.promo !== null))
    // The same product and price twice in one post is one deal.
    .filter((it, i, all) => all.findIndex((o) => sharedDealId(place, o) === sharedDealId(place, it)) === i);
  if (items.length === 0) throw new ShareError("We couldn't find a price in that. Try a screenshot that shows the item and price.");

  const now = Timestamp.now();
  const refs = items.map((it) => db.doc(`sharedDeals/${sharedDealId(place, it)}`));
  const out: SharedDealOut[] = [];
  await db.runTransaction(async (tx) => {
    const old = await tx.getAll(...refs);
    items.forEach((it, i) => {
      const prev = old[i];
      const live = prev.exists && prev.get("status") !== "gone" && String(prev.get("validTo")) >= today;
      const here = live ? [...new Set([...((prev.get("here") as string[]) ?? []), uid])] : [uid];
      const gone = live ? ((prev.get("gone") as string[]) ?? []).filter((u) => u !== uid) : [];
      const savings = it.regularPrice !== null && it.salePrice !== null ? round2(it.regularPrice - it.salePrice) : null;
      const prevTo = live ? String(prev.get("validTo")) : "";
      tx.set(refs[i], {
        storeId: input.storeId,
        storeName,
        chain,
        chainKey: key,
        scope,
        clearance: post.clearance,
        name: it.name,
        brand: it.brand,
        size: it.size,
        soldBy: it.soldBy,
        category: it.category,
        regularPrice: it.regularPrice,
        salePrice: it.salePrice,
        savings,
        pctOff: savings !== null && it.regularPrice ? Math.round((savings / it.regularPrice) * 100) : 0,
        promo: it.promo,
        validTo: prevTo > validTo ? prevTo : validTo,
        endDateFromPost: endDateFromPost || (live && prev.get("endDateFromPost") === true),
        url: url ?? (live ? prev.get("url") ?? null : null),
        source: "shopper-share",
        status: "active",
        here,
        gone,
        sharedBy: live ? prev.get("sharedBy") : uid,
        sharedAt: live ? prev.get("sharedAt") : now,
        updatedAt: now,
      });
      out.push({
        id: refs[i].id,
        name: it.name,
        brand: it.brand,
        size: it.size,
        soldBy: it.soldBy,
        salePrice: it.salePrice,
        regularPrice: it.regularPrice,
        promo: it.promo,
        category: it.category,
        alreadyShared: live,
      });
    });
  });

  // What was read (not the screenshot), so bad shares can be traced and removed.
  await db.collection("dealShares").add({
    uid,
    storeId: input.storeId,
    url,
    text: text.slice(0, 1000),
    hadImage: !!input.imageBase64,
    read: post,
    dealIds: refs.map((r) => r.id),
    at: now,
  });

  return {
    storeId: input.storeId,
    storeName,
    scope,
    clearance: post.clearance,
    validTo,
    endDateFromPost,
    deals: out,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

/**
 * "Still there" or "Gone" from a shopper who checked. "Still there" keeps a deal without an end
 * date for a few more days; once "Gone" outnumbers "Still there" by two, it's hidden.
 */
export async function voteSharedDeal(db: Firestore, uid: string, id: string, vote: "here" | "gone", today: string) {
  const ref = db.doc(`sharedDeals/${id}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new ShareError("That deal wasn't found.");
    const here = new Set((snap.get("here") as string[]) ?? []);
    const gone = new Set((snap.get("gone") as string[]) ?? []);
    (vote === "here" ? gone : here).delete(uid);
    (vote === "here" ? here : gone).add(uid);
    let validTo = String(snap.get("validTo"));
    if (vote === "here" && snap.get("endDateFromPost") !== true) {
      const later = addDays(today, SHARE_DAYS.stillThere);
      if (later > validTo) validTo = later;
    }
    const status = gone.size >= here.size + 2 ? "gone" : "active";
    tx.update(ref, { here: [...here], gone: [...gone], validTo, status, updatedAt: Timestamp.now() });
    return { id, here: here.size, gone: gone.size, validTo, status };
  });
}

/** A shared deal as the planner sees it. */
export type PlannerSharedDeal = Deal & { sharedId: string };

/** Live shared deals for a store: its own, plus chain-wide ones. */
export async function liveSharedDeals(db: Firestore, storeId: string, chain: string, today: string): Promise<PlannerSharedDeal[]> {
  const [mine, chainWide] = await Promise.all([
    db.collection("sharedDeals").where("storeId", "==", storeId).where("status", "==", "active").get(),
    db.collection("sharedDeals").where("chainKey", "==", chainKey(chain)).where("scope", "==", "chain").where("status", "==", "active").get(),
  ]);
  const seen = new Set<string>();
  const out: PlannerSharedDeal[] = [];
  for (const doc of [...mine.docs, ...chainWide.docs]) {
    if (seen.has(doc.id) || String(doc.get("validTo")) < today) continue;
    seen.add(doc.id);
    const d = doc.data();
    out.push({
      sharedId: doc.id,
      storeId,
      chain: d.chain,
      productId: `shared-${doc.id}`,
      name: d.name,
      brand: d.brand ?? null,
      size: d.size ?? null,
      soldBy: d.soldBy ?? null,
      category: d.category,
      krogerCategories: [],
      imageUrl: null,
      regularPrice: d.regularPrice ?? null,
      salePrice: d.salePrice ?? null,
      savings: d.savings ?? null,
      pctOff: d.pctOff ?? 0,
      promo: [d.clearance ? "spotted by a shopper, may sell out" : "spotted by a shopper", d.promo].filter(Boolean).join("; "),
      validTo: d.validTo,
      source: "shopper-share",
      fetchedAt: d.updatedAt,
    });
  }
  return out;
}
