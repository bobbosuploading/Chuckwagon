import { initializeApp } from "firebase-admin/app";
import { FieldValue, Firestore, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { planMeals, PlanRequest } from "./plan";

initializeApp();

// Deal collection does NOT run here: Kroger's bot protection blocks requests
// from Google Cloud. It runs from GitHub Actions instead
// (.github/workflows/collect-kroger.yml -> functions/src/cli.ts).

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");

/** Spending guards. Everyday plans cost about half a cent; premium about 17 cents. */
const LIMITS = {
  freePerDay: 3, // everyday plans per user per day
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
    if (premium && user.get("premium") !== true) {
      throw new HttpsError("permission-denied", "Chef's pick is a premium feature. It's coming soon!");
    }
    if (premium && ((mo.get("premium") as number | undefined) ?? 0) >= LIMITS.premiumPerMonth) {
      throw new HttpsError("resource-exhausted", `You've used all ${LIMITS.premiumPerMonth} Chef's picks this month. Everyday plans still work.`);
    }
    if (!premium && ((m.get("free") as number | undefined) ?? 0) >= LIMITS.freePerDay) {
      throw new HttpsError("resource-exhausted", `You've made ${LIMITS.freePerDay} plans today. Your saved plans are under My plans, and you can make more tomorrow.`);
    }
    if (((e.get("total") as number | undefined) ?? 0) >= LIMITS.allUsersPerDay) {
      throw new HttpsError("resource-exhausted", "Chuckwagon is extra busy today. Please try again tomorrow.");
    }
    if (premium) tx.set(month, { uid, month: day.slice(0, 7), premium: FieldValue.increment(1) }, { merge: true });
    else tx.set(mine, { uid, day, free: FieldValue.increment(1) }, { merge: true });
    tx.set(everyone, { day, total: FieldValue.increment(1) }, { merge: true });
  });
}

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
