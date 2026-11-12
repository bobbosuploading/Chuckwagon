import { initializeApp } from "firebase-admin/app";
import { FieldValue, Firestore, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import { requireApp } from "./appCheck";
import Anthropic from "@anthropic-ai/sdk";
import { chooseMeals, MealPlan, planMeals, PlanRequest } from "./plan";
import { ReceiptError, scanReceipt } from "./receipts";
import { AdScanError, scanAd } from "./adScans";
import { ShareError, shareDeal, voteSharedDeal } from "./sharedDeals";

initializeApp();

// Deal collection does NOT run here: Kroger's bot protection blocks requests
// from Google Cloud. It runs from GitHub Actions instead
// (.github/workflows/collect-kroger.yml -> functions/src/cli.ts).

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

/** Spending guards. Everyday plans cost about half a cent; premium about 17 cents. */
const LIMITS = {
  freePerDay: 3, // everyday plans per user per day
  bonusPerDay: 3, // extra everyday plans a day earned by scanning receipts (one per receipt)
  receiptsPerChefPick: 3, // every 3rd new receipt earns one free Chef's pick
  premiumPerMonth: 10, // premium (Opus) plans per subscriber per month, about $1.70
  allUsersPerDay: 300, // kill switch: total plans per day across everyone
};

/** Central-time date, so limits reset at midnight in Texas. */
function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/**
 * Counts this request against the daily limits, or refuses it.
 * Premium is allowed only when users/{uid}.premium is true (set by the backend, never the app).
 */
async function reservePlan(db: Firestore, uid: string, premium: boolean): Promise<void> {
  const day = today();
  const userRef = db.collection("users").doc(uid);
  const mine = db.collection("usage").doc(`${uid}_${day}`);
  const everyone = db.collection("usage").doc(`all_${day}`);
  const month = db.collection("usage").doc(`${uid}_${day.slice(0, 7)}`);
  await db.runTransaction(async (tx) => {
    const [user, m, e, mo] = await Promise.all([tx.get(userRef), tx.get(mine), tx.get(everyone), tx.get(month)]);
    // Non-premium shoppers can use a free Chef's pick earned by scanning receipts.
    const credits = (user.get("chefPickCredits") as number | undefined) ?? 0;
    const useCredit = premium && user.get("premium") !== true && credits > 0;
    if (premium && user.get("premium") !== true && !useCredit) {
      throw new HttpsError(
        "permission-denied",
        `Chef's pick is a premium feature. Scan ${LIMITS.receiptsPerChefPick} receipts to earn a free one!`
      );
    }
    if (premium && !useCredit && ((mo.get("premium") as number | undefined) ?? 0) >= LIMITS.premiumPerMonth) {
      throw new HttpsError("resource-exhausted", `You've used all ${LIMITS.premiumPerMonth} Chef's picks this month. Everyday plans still work.`);
    }
    const bonus = Math.min((m.get("bonus") as number | undefined) ?? 0, LIMITS.bonusPerDay);
    const allowed = LIMITS.freePerDay + bonus;
    if (!premium && ((m.get("free") as number | undefined) ?? 0) >= allowed) {
      throw new HttpsError("resource-exhausted", `You've made ${allowed} plans today. Scan a receipt for another one, or come back tomorrow. Your saved plans are under My plans.`);
    }
    if (useCredit) tx.set(userRef, { chefPickCredits: FieldValue.increment(-1) }, { merge: true });
    if (((e.get("total") as number | undefined) ?? 0) >= LIMITS.allUsersPerDay) {
      throw new HttpsError("resource-exhausted", "Chuckwagon is extra busy today. Please try again tomorrow.");
    }
    if (premium) tx.set(month, { uid, month: day.slice(0, 7), premium: FieldValue.increment(1) }, { merge: true });
    else tx.set(mine, { uid, day, free: FieldValue.increment(1) }, { merge: true });
    tx.set(everyone, { day, total: FieldValue.increment(1) }, { merge: true });
  });
}

/** During testing, deals are collected for at most this many areas (ZIP codes). */
const MAX_AREAS = 15;

/**
 * Adds a shopper's ZIP to areas/{zip}, the list of places the collectors cover.
 * Returns "ready" if deals are already collected there, "pending" if the first
 * collection still has to run, or "waitlist" if the beta is full.
 */
export const registerArea = onCall(async (request) => {
  requireApp(request, "registerArea");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const zip = String(request.data?.zip ?? "").trim();
  if (!/^\d{5}$/.test(zip)) throw new HttpsError("invalid-argument", "Please send a 5-digit ZIP code");
  const db = getFirestore();
  const uid = request.auth.uid;
  const status = await db.runTransaction(async (tx) => {
    const ref = db.collection("areas").doc(zip);
    const area = await tx.get(ref);
    const now = new Date().toISOString();
    if (area.exists) {
      tx.update(ref, { users: FieldValue.arrayUnion(uid), lastRequestedAt: now });
      return area.get("status") as string;
    }
    // Areas we already collect for (like the original El Campo ZIP) count as ready.
    const [byZip, byAddress] = await Promise.all([
      tx.get(db.collection("stores").where("zip", "==", zip).limit(1)),
      tx.get(db.collection("stores").where("address.zipCode", "==", zip).limit(1)),
    ]);
    const active = await tx.get(db.collection("areas").where("status", "in", ["ready", "pending"]).count());
    const status = !byZip.empty || !byAddress.empty ? "ready" : active.data().count >= MAX_AREAS ? "waitlist" : "pending";
    tx.set(ref, { zip, status, users: [uid], createdAt: now, lastRequestedAt: now });
    return status;
  });
  logger.info("Area registered", { zip, status });
  return { status };
});

/**
 * Unlocks premium for testers. Codes live in codes/{CODE} (create them in the Firebase console):
 *   premium: true, maxUses: 25, uses: 0, expiresAt: "2027-02-01" (optional)
 */
export const redeemTesterCode = onCall(async (request) => {
  requireApp(request, "redeemTesterCode");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const code = String(request.data?.code ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,32}$/.test(code)) throw new HttpsError("invalid-argument", "That code doesn't look right.");
  const db = getFirestore();
  const uid = request.auth.uid;
  await db.runTransaction(async (tx) => {
    const ref = db.collection("codes").doc(code);
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get("premium") !== true) throw new HttpsError("not-found", "That code isn't valid.");
    const expires = snap.get("expiresAt") as string | undefined;
    if (expires && Date.parse(expires) < Date.now()) throw new HttpsError("failed-precondition", "That code has expired.");
    const uses = (snap.get("uses") as number | undefined) ?? 0;
    const max = (snap.get("maxUses") as number | undefined) ?? 25;
    if (uses >= max) throw new HttpsError("resource-exhausted", "That code has been used up.");
    tx.update(ref, { uses: FieldValue.increment(1), usedBy: FieldValue.arrayUnion(uid) });
    tx.set(db.collection("users").doc(uid), { premium: true, premiumSource: `code:${code}`, premiumSince: new Date().toISOString() }, { merge: true });
  });
  logger.info("Tester code redeemed", { uid, code });
  return { premium: true };
});

/**
 * "Headed to [store]". Called from the iOS app (and later Bloom Circle) by signed-in users.
 * Saves the plan to plans/{id} and returns it.
 */
export const planMealsForStore = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 300, memory: "512MiB" },
  async (request) => {
    requireApp(request, "planMealsForStore");
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to plan meals");
    const data = request.data as PlanRequest;
    if (!data?.storeId) throw new HttpsError("invalid-argument", "storeId is required");
    const db = getFirestore();
    await reservePlan(db, request.auth.uid, data.premium === true);
    try {
      const plan = await planMeals(db, new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }), data);
      const ref = await db.collection("plans").add({ ...plan, uid: request.auth.uid });
      logger.info("Plan created", { id: ref.id, model: plan.model, usage: plan.usage });
      return { id: ref.id, ...plan };
    } catch (err) {
      logger.error("Plan failed", err);
      throw new HttpsError("internal", (err as Error).message);
    }
  }
);

/**
 * Picks which meal ideas to cook in a plan made with extraMeals, and rebuilds its grocery
 * list and totals from the prices saved with it. No model call and no plan used up.
 * Data: { planId, meals: [meal names] }. Returns the updated plan.
 */
export const choosePlanMeals = onCall(async (request) => {
  requireApp(request, "choosePlanMeals");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const { planId, meals } = (request.data ?? {}) as { planId?: string; meals?: unknown };
  if (!planId || !Array.isArray(meals)) throw new HttpsError("invalid-argument", "planId and meals are required");
  const names = meals.filter((m): m is string => typeof m === "string").slice(0, 20);
  const db = getFirestore();
  const ref = db.collection("plans").doc(planId);
  const snap = await ref.get();
  if (!snap.exists || snap.get("uid") !== request.auth.uid) throw new HttpsError("not-found", "That plan wasn't found.");
  const plan = snap.data() as MealPlan;
  let picked;
  try {
    picked = chooseMeals(plan, names);
  } catch (err) {
    throw new HttpsError("failed-precondition", (err as Error).message);
  }
  // Firestore rejects undefined values; a plan without a budget has none to save.
  const update = JSON.parse(JSON.stringify(picked));
  await ref.update(update);
  return { id: ref.id, ...plan, ...picked, checked: snap.get("checked") ?? [] };
});

/** Receipt scans cost about a third of a cent each (Haiku reading one photo). */
const RECEIPT_LIMITS = { perUserPerDay: 10, allUsersPerDay: 500 };

/**
 * Photo uploads on a weak cell signal can take a minute or more before the model even starts,
 * so photo functions get 4 minutes. The app waits a little longer than this (Backend.swift).
 */
const PHOTO_TIMEOUT_SECONDS = 240;
/** Shown when a photo scan fails for a reason the shopper can't fix (details go to the log). */
const PHOTO_FAILED = "We couldn't read that photo just now. Please try again in a minute.";

/**
 * "Scan a receipt": reads a receipt photo and saves its everyday prices for that store,
 * so meal plans can price items that aren't on sale. Data: { storeId, imageBase64, mediaType }.
 */
export const scanReceiptPhoto = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: PHOTO_TIMEOUT_SECONDS, memory: "512MiB" },
  async (request) => {
    requireApp(request, "scanReceiptPhoto");
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to scan receipts");
    const { storeId, imageBase64, mediaType } = (request.data ?? {}) as {
      storeId?: string;
      imageBase64?: string;
      mediaType?: string;
    };
    if (!storeId || !imageBase64) throw new HttpsError("invalid-argument", "storeId and imageBase64 are required");
    if (imageBase64.length > 7_000_000) throw new HttpsError("invalid-argument", "That photo is too large.");
    const type = (["image/jpeg", "image/png", "image/webp"].includes(mediaType ?? "") ? mediaType : "image/jpeg") as
      "image/jpeg" | "image/png" | "image/webp";

    const db = getFirestore();
    const uid = request.auth.uid;
    const day = today();
    const mine = db.collection("usage").doc(`${uid}_${day}`);
    const everyone = db.collection("usage").doc(`all_${day}`);
    await db.runTransaction(async (tx) => {
      const [m, e] = await Promise.all([tx.get(mine), tx.get(everyone)]);
      if (((m.get("receipts") as number | undefined) ?? 0) >= RECEIPT_LIMITS.perUserPerDay) {
        throw new HttpsError("resource-exhausted", `You've scanned ${RECEIPT_LIMITS.perUserPerDay} receipts today. Thanks! Try again tomorrow.`);
      }
      if (((e.get("receipts") as number | undefined) ?? 0) >= RECEIPT_LIMITS.allUsersPerDay) {
        throw new HttpsError("resource-exhausted", "Receipt scanning is extra busy today. Please try again tomorrow.");
      }
      tx.set(mine, { uid, day, receipts: FieldValue.increment(1) }, { merge: true });
      tx.set(everyone, { day, receipts: FieldValue.increment(1) }, { merge: true });
    });

    try {
      const result = await scanReceipt(db, new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }), uid, storeId, imageBase64, type);
      logger.info("Receipt scanned", { uid, storeId, items: result.items.length, receiptId: result.receiptId });
      return { ...result, reward: await rewardReceipt(db, uid, day, result.duplicate, result.items.length) };
    } catch (err) {
      logger.warn("Receipt scan failed", err);
      if (err instanceof ReceiptError) throw new HttpsError("failed-precondition", err.message);
      throw new HttpsError("internal", PHOTO_FAILED);
    }
  }
);

/** Ad scans cost about the same as receipts. A shopper rarely has more than a few ad pages. */
const AD_LIMITS = { perUserPerDay: 10, allUsersPerDay: 300 };

/**
 * "Scan a weekly ad": reads one page of a printed weekly ad and saves its deals, for stores
 * whose ad we can't load automatically (see adScans.ts).
 * Data: { storeId } for one of the shopper's stores, or { zip, lat?, lng? } for a store we
 * don't have yet (named from the ad); plus { imageBase64, mediaType }.
 */
export const scanAdPhoto = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: PHOTO_TIMEOUT_SECONDS, memory: "512MiB" },
  async (request) => {
    requireApp(request, "scanAdPhoto");
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to scan ads");
    const { storeId, zip, lat, lng, imageBase64, mediaType } = (request.data ?? {}) as {
      storeId?: string;
      zip?: string;
      lat?: number;
      lng?: number;
      imageBase64?: string;
      mediaType?: string;
    };
    if ((!storeId && !zip) || !imageBase64) throw new HttpsError("invalid-argument", "storeId or zip, and imageBase64, are required");
    if (imageBase64.length > 7_000_000) throw new HttpsError("invalid-argument", "That photo is too large.");
    const type = (["image/jpeg", "image/png", "image/webp"].includes(mediaType ?? "") ? mediaType : "image/jpeg") as
      "image/jpeg" | "image/png" | "image/webp";

    const db = getFirestore();
    const uid = request.auth.uid;
    const day = today();
    const mine = db.collection("usage").doc(`${uid}_${day}`);
    const everyone = db.collection("usage").doc(`all_${day}`);
    await db.runTransaction(async (tx) => {
      const [m, e] = await Promise.all([tx.get(mine), tx.get(everyone)]);
      if (((m.get("adScans") as number | undefined) ?? 0) >= AD_LIMITS.perUserPerDay) {
        throw new HttpsError("resource-exhausted", `You've scanned ${AD_LIMITS.perUserPerDay} ad pages today. Thanks! Try again tomorrow.`);
      }
      if (((e.get("adScans") as number | undefined) ?? 0) >= AD_LIMITS.allUsersPerDay) {
        throw new HttpsError("resource-exhausted", "Ad scanning is extra busy today. Please try again tomorrow.");
      }
      tx.set(mine, { uid, day, adScans: FieldValue.increment(1) }, { merge: true });
      tx.set(everyone, { day, adScans: FieldValue.increment(1) }, { merge: true });
    });

    try {
      const where = {
        storeId: storeId || undefined,
        zip: zip ? String(zip).trim() : undefined,
        lat: typeof lat === "number" && Number.isFinite(lat) ? lat : undefined,
        lng: typeof lng === "number" && Number.isFinite(lng) ? lng : undefined,
      };
      const result = await scanAd(db, new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }), uid, where, imageBase64, type, day);
      logger.info("Ad scanned", { uid, storeId: result.storeId, newStore: result.newStore, deals: result.deals.length });
      return { ...result, reward: await rewardReceipt(db, uid, day, result.duplicate, result.deals.length) };
    } catch (err) {
      logger.warn("Ad scan failed", err);
      if (err instanceof AdScanError) throw new HttpsError("failed-precondition", err.message);
      throw new HttpsError("internal", PHOTO_FAILED);
    }
  }
);

/** Shared deals cost about the same as an ad scan (one Haiku call). */
const SHARE_LIMITS = { perUserPerDay: 10, allUsersPerDay: 300 };

/**
 * "Share a deal": a deal a shopper saw on social media, a deal site or in a message, shared as a
 * screenshot, a link and/or text. It shows at that store (or every store of the chain) until it
 * ends or shoppers say it's gone (see sharedDeals.ts).
 * Data: { storeId, imageBase64?, mediaType?, url?, text? }.
 */
export const shareDealPost = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: PHOTO_TIMEOUT_SECONDS, memory: "512MiB" },
  async (request) => {
    requireApp(request, "shareDealPost");
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to share deals");
    const { storeId, imageBase64, mediaType, url, text } = (request.data ?? {}) as {
      storeId?: string;
      imageBase64?: string;
      mediaType?: string;
      url?: string;
      text?: string;
    };
    if (!storeId || typeof storeId !== "string") throw new HttpsError("invalid-argument", "Pick the store the deal is at.");
    if (!imageBase64 && !url && !text) throw new HttpsError("invalid-argument", "Share a screenshot, a link or the post's text.");
    if (imageBase64 && (typeof imageBase64 !== "string" || imageBase64.length > 7_000_000)) {
      throw new HttpsError("invalid-argument", "That picture is too large.");
    }
    const type = (["image/jpeg", "image/png", "image/webp"].includes(mediaType ?? "") ? mediaType : "image/jpeg") as
      "image/jpeg" | "image/png" | "image/webp";

    const db = getFirestore();
    const uid = request.auth.uid;
    const day = today();
    const mine = db.collection("usage").doc(`${uid}_${day}`);
    const everyone = db.collection("usage").doc(`all_${day}`);
    await db.runTransaction(async (tx) => {
      const [m, e] = await Promise.all([tx.get(mine), tx.get(everyone)]);
      if (((m.get("shares") as number | undefined) ?? 0) >= SHARE_LIMITS.perUserPerDay) {
        throw new HttpsError("resource-exhausted", `You've shared ${SHARE_LIMITS.perUserPerDay} deals today. Thanks! Try again tomorrow.`);
      }
      if (((e.get("shares") as number | undefined) ?? 0) >= SHARE_LIMITS.allUsersPerDay) {
        throw new HttpsError("resource-exhausted", "Deal sharing is extra busy today. Please try again tomorrow.");
      }
      tx.set(mine, { uid, day, shares: FieldValue.increment(1) }, { merge: true });
      tx.set(everyone, { day, shares: FieldValue.increment(1) }, { merge: true });
    });

    try {
      const result = await shareDeal(
        db,
        new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }),
        uid,
        {
          storeId,
          imageBase64: imageBase64 || undefined,
          mediaType: type,
          url: typeof url === "string" ? url.slice(0, 2000) : undefined,
          text: typeof text === "string" ? text : undefined,
        },
        day
      );
      logger.info("Deal shared", { uid, storeId, scope: result.scope, deals: result.deals.length });
      return result;
    } catch (err) {
      logger.warn("Deal share failed", err);
      if (err instanceof ShareError) throw new HttpsError("failed-precondition", err.message);
      throw new HttpsError("internal", PHOTO_FAILED);
    }
  }
);

/** "Still there" / "Gone" on a deal a shopper shared. Data: { id, vote: "here" | "gone" }. */
export const voteSharedDealPost = onCall(async (request) => {
  requireApp(request, "voteSharedDealPost");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const { id, vote } = (request.data ?? {}) as { id?: string; vote?: string };
  if (!id || !/^[a-f0-9]{24}$/.test(id) || (vote !== "here" && vote !== "gone")) {
    throw new HttpsError("invalid-argument", "id and vote (here or gone) are required");
  }
  try {
    return await voteSharedDeal(getFirestore(), request.auth.uid, id, vote, today());
  } catch (err) {
    if (err instanceof ShareError) throw new HttpsError("not-found", err.message);
    throw err;
  }
});

/**
 * Thanks shoppers for scanning: each new receipt or ad page (3+ prices, not scanned before) adds one
 * everyday plan for today (up to LIMITS.bonusPerDay), and every 3rd earns a free Chef's pick.
 */
async function rewardReceipt(db: Firestore, uid: string, day: string, duplicate: boolean, prices: number) {
  const userRef = db.collection("users").doc(uid);
  const mine = db.collection("usage").doc(`${uid}_${day}`);
  if (duplicate || prices < 3) {
    return { earned: false, reason: duplicate ? "already-scanned" : "too-few-prices", extraPlansToday: 0, chefPickCredits: null, receiptsToNextChefPick: null };
  }
  return db.runTransaction(async (tx) => {
    const [user, m] = await Promise.all([tx.get(userRef), tx.get(mine)]);
    const count = ((user.get("receiptCount") as number | undefined) ?? 0) + 1;
    const earnsPick = count % LIMITS.receiptsPerChefPick === 0;
    const credits = ((user.get("chefPickCredits") as number | undefined) ?? 0) + (earnsPick ? 1 : 0);
    const bonus = Math.min(((m.get("bonus") as number | undefined) ?? 0) + 1, LIMITS.bonusPerDay);
    tx.set(userRef, { receiptCount: count, chefPickCredits: credits }, { merge: true });
    tx.set(mine, { uid, day, bonus }, { merge: true });
    return {
      earned: true,
      reason: null,
      extraPlansToday: bonus,
      chefPickCredits: credits,
      earnedChefPick: earnsPick,
      receiptsToNextChefPick: LIMITS.receiptsPerChefPick - (count % LIMITS.receiptsPerChefPick),
    };
  });
}

// Send to cart: Kroger sign-in and Instacart shopping lists (see cart.ts).
export { krogerConnectUrl, krogerCallback, krogerAccessToken, krogerDisconnect, instacartShoppingList } from "./cart";
