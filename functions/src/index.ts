import { initializeApp } from "firebase-admin/app";
import { FieldValue, Firestore, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { planMeals, PlanRequest } from "./plan";
import { scanReceipt } from "./receipts";

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

/** Receipt scans cost about a third of a cent each (Haiku reading one photo). */
const RECEIPT_LIMITS = { perUserPerDay: 10, allUsersPerDay: 500 };

/**
 * "Scan a receipt": reads a receipt photo and saves its everyday prices for that store,
 * so meal plans can price items that aren't on sale. Data: { storeId, imageBase64, mediaType }.
 */
export const scanReceiptPhoto = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" },
  async (request) => {
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
      throw new HttpsError("internal", (err as Error).message);
    }
  }
);

/**
 * Thanks shoppers for scanning: each new receipt (3+ prices, not scanned before) adds one
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
