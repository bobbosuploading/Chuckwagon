/**
 * Cloud functions for meal macros:
 *  - addPlanMacros: the app asks for a plan's per-serving macros (worked out once, then saved on
 *    the plan as plans/{id}.mealMacros, keyed by meal name).
 *  - bloomMeals: Bloom Circle (the fitness app, a separate Firebase project from the same Apple
 *    developer team) lists a shopper's recent Chuckwagon meals with macros when logging a meal.
 *
 * How Bloom proves who the shopper is: Sign in with Apple gives each person one user id ("sub")
 * that is the same in every app from the same Apple developer team. Bloom sends its own Firebase
 * ID token; we check it was issued by Bloom's Firebase project, read the Apple id in it, and find
 * the Chuckwagon account signed in with that same Apple id. No shared password is needed, and a
 * Chuckwagon account that never signed in with Apple can't be matched.
 */
import { getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, type Firestore, getFirestore } from "firebase-admin/firestore";
import { defineSecret, defineString } from "firebase-functions/params";
import { HttpsError, onCall, onRequest } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import Anthropic from "@anthropic-ai/sdk";
import { requireApp } from "./appCheck";
import { computeMealMacros, hasAllMacros, MealMacros, planMeals } from "./nutrition";

const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
/** Free key from https://api.data.gov/signup (1,000 lookups an hour). DEMO_KEY works for a quick test only. */
const USDA_API_KEY = defineString("USDA_API_KEY", { default: "DEMO_KEY" });
/**
 * Bloom Circle's Firebase project id (not a secret). Override with the BLOOM_FIREBASE_PROJECT_ID
 * repo variable; set it to "off" to turn bloomMeals off.
 * Bloom users start anonymous and link Apple later, so sign_in_provider can still say "anonymous";
 * the Apple id is read from firebase.identities["apple.com"] instead, which linking adds.
 */
const BLOOM_FIREBASE_PROJECT_ID = defineString("BLOOM_FIREBASE_PROJECT_ID", { default: "bloom-circle-3f6b8" });

/** Working out macros costs a fraction of a cent (two small Haiku calls); foods are cached for everyone. */
const MACRO_LIMITS = { perUserPerDay: 20, allUsersPerDay: 600 };
/** Bloom only reads saved data (plus the occasional macros fill-in), so this is just a safety net. */
const BLOOM_LIMITS = { perUserPerDay: 200 };
/** How long bloomMeals waits for macros fill-ins before answering. Bloom's request times out at 20 s. */
const FILL_BUDGET_MS = 8_000;
/** Plans this server is already working out macros for, so a retry doesn't start the same work again. */
const fillsInFlight = new Set<string>();

function today(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

/** Counts one macros job against the daily limits, or throws resource-exhausted. */
async function reserveMacros(db: Firestore, uid: string): Promise<void> {
  const day = today();
  const mine = db.collection("usage").doc(`${uid}_${day}`);
  const everyone = db.collection("usage").doc(`all_${day}`);
  await db.runTransaction(async (tx) => {
    const [m, e] = await Promise.all([tx.get(mine), tx.get(everyone)]);
    if (((m.get("macros") as number | undefined) ?? 0) >= MACRO_LIMITS.perUserPerDay ||
        ((e.get("macros") as number | undefined) ?? 0) >= MACRO_LIMITS.allUsersPerDay) {
      throw new HttpsError("resource-exhausted", "Nutrition info is taking a break. Try again tomorrow.");
    }
    tx.set(mine, { uid, day, macros: FieldValue.increment(1) }, { merge: true });
    tx.set(everyone, { day, macros: FieldValue.increment(1) }, { merge: true });
  });
}

/** Works out and saves macros for a plan that doesn't have them yet. Returns the plan's macros. */
async function fillMacros(db: Firestore, planId: string, plan: FirebaseFirestore.DocumentData): Promise<Record<string, MealMacros>> {
  const existing = (plan.mealMacros ?? {}) as Record<string, MealMacros>;
  if (hasAllMacros(plan)) return existing;
  await reserveMacros(db, plan.uid as string);
  const result = await computeMealMacros(
    db,
    new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() }),
    planMeals(plan),
    USDA_API_KEY.value() || "DEMO_KEY"
  );
  const mealMacros = { ...existing, ...result.macros };
  await db.collection("plans").doc(planId).update({ mealMacros });
  logger.info("Macros added", { planId, meals: Object.keys(result.macros).length, lookups: result.lookups,
    inputTokens: result.inputTokens, outputTokens: result.outputTokens });
  return mealMacros;
}

/**
 * Per-serving macros for one of the shopper's plans. Data: { planId }. Returns { mealMacros }.
 * Called by the app when it shows a plan without them (new plans, and plans made before macros).
 */
export const addPlanMacros = onCall({ secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120 }, async (request) => {
  requireApp(request, "addPlanMacros");
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first");
  const planId = (request.data as { planId?: unknown } | undefined)?.planId;
  if (typeof planId !== "string" || !planId || planId.includes("/")) throw new HttpsError("invalid-argument", "planId is required");
  const db = getFirestore();
  const snap = await db.collection("plans").doc(planId).get();
  if (!snap.exists || snap.get("uid") !== request.auth.uid) throw new HttpsError("not-found", "That plan wasn't found.");
  try {
    return { mealMacros: await fillMacros(db, planId, snap.data()!) };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    logger.error("Macros failed", { planId, err });
    throw new HttpsError("internal", "Couldn't work out nutrition just now.");
  }
});

function bloomAuth() {
  const projectId = BLOOM_FIREBASE_PROJECT_ID.value();
  const app = getApps().some((a) => a.name === "bloom") ? getApp("bloom") : initializeApp({ projectId }, "bloom");
  return getAuth(app);
}

/** One meal as Bloom sees it. Macros are per serving; null while they're still being worked out. */
export interface BloomMeal {
  /** Stable id: planId + meal name. */
  id: string;
  planId: string;
  name: string;
  servings: number;
  perServing: MealMacros["perServing"] | null;
  /** Share of the meal's weight with USDA data, 0 to 1. */
  coverage: number | null;
  ingredients: { item: string; amount: string }[];
  timeMinutes: number | null;
  storeName: string;
  plannedAt: string;
}

/**
 * GET (or POST) https://us-central1-chuckwagon-ebbcc.cloudfunctions.net/bloomMeals
 * Header: Authorization: Bearer <the shopper's Bloom Circle Firebase ID token>
 * Optional query: days (1-90, default 30), limit (1-50 meals, default 30).
 *
 * 200 { linked: true, meals: BloomMeal[] }, newest first, picked meals only, one per name.
 * 200 { linked: false, reason } when there's no Chuckwagon account signed in with the same Apple ID.
 * 401 bad or missing token, 403 the Bloom account isn't signed in with Apple, 503 not set up.
 */
export const bloomMeals = onRequest(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "256MiB", maxInstances: 5 },
  async (req, res) => {
    if (req.method !== "GET" && req.method !== "POST") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    const bloomProject = BLOOM_FIREBASE_PROJECT_ID.value();
    if (!bloomProject || bloomProject === "off") {
      res.status(503).json({ error: "not_configured" });
      return;
    }
    const token = /^Bearer (.+)$/.exec(req.get("authorization") ?? "")?.[1];
    if (!token) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    let appleSub: string | undefined;
    try {
      // Checks the signature, expiry, and that Bloom's project issued it (aud and iss).
      const decoded = await bloomAuth().verifyIdToken(token);
      appleSub = (decoded.firebase?.identities?.["apple.com"] as string[] | undefined)?.[0];
    } catch (err) {
      logger.warn("Bloom token rejected", { err: (err as Error).message });
      res.status(401).json({ error: "invalid_token" });
      return;
    }
    if (!appleSub) {
      res.status(403).json({ error: "not_signed_in_with_apple" });
      return;
    }

    let uid: string;
    try {
      uid = (await getAuth().getUserByProviderUid("apple.com", appleSub)).uid;
    } catch {
      res.json({ linked: false, reason: "no_chuckwagon_account" });
      return;
    }

    const db = getFirestore();
    const day = today();
    const usage = db.collection("usage").doc(`${uid}_${day}`);
    const calls = ((await usage.get()).get("bloomCalls") as number | undefined) ?? 0;
    if (calls >= BLOOM_LIMITS.perUserPerDay) {
      res.status(429).json({ error: "rate_limited" });
      return;
    }
    await usage.set({ uid, day, bloomCalls: FieldValue.increment(1) }, { merge: true });

    const params = { ...req.query, ...(typeof req.body === "object" && req.body ? req.body : {}) } as Record<string, unknown>;
    const clamp = (v: unknown, min: number, max: number, dflt: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : dflt;
    };
    const days = clamp(params.days, 1, 90, 30);
    const limit = clamp(params.limit, 1, 50, 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const plans = await db
      .collection("plans")
      .where("uid", "==", uid)
      .where("createdAt", ">=", since)
      .orderBy("createdAt", "desc")
      .limit(20)
      .get();

    // Fill in macros for a couple of plans that don't have them yet, so older plans show up with
    // numbers. Working them out takes 10-30 seconds a plan, and Bloom gives up after 20, so wait at
    // most FILL_BUDGET_MS. Anything not done in time is sent as "Nutrition coming soon" and keeps
    // going on the server, so the numbers are there next time.
    const toFill = plans.docs.filter((d) => !hasAllMacros(d.data()) && !fillsInFlight.has(d.id)).slice(0, 2);
    const filledMacros = new Map<string, Record<string, MealMacros>>();
    const fills = toFill.map((d) => {
      fillsInFlight.add(d.id);
      return fillMacros(db, d.id, d.data())
        .then((m) => { filledMacros.set(d.id, m); })
        .catch((err) => logger.warn("Macros fill-in for Bloom failed", { planId: d.id, err: (err as Error).message }))
        .finally(() => fillsInFlight.delete(d.id));
    });
    if (fills.length) {
      await Promise.race([Promise.all(fills), new Promise((r) => setTimeout(r, FILL_BUDGET_MS))]);
    }

    const meals: BloomMeal[] = [];
    const seen = new Set<string>();
    for (const doc of plans.docs) {
      const plan = doc.data();
      const macros = filledMacros.get(doc.id) ?? ((plan.mealMacros ?? {}) as Record<string, MealMacros>);
      for (const m of (plan.meals ?? []) as { name: string; servings: number; timeMinutes?: number; ingredients?: { item: string; amount: string }[] }[]) {
        if (!m?.name) continue;
        const key = m.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const mm = macros[m.name];
        meals.push({
          id: `${doc.id}:${m.name}`,
          planId: doc.id,
          name: m.name,
          servings: m.servings,
          perServing: mm?.perServing ?? null,
          coverage: mm?.coverage ?? null,
          ingredients: (m.ingredients ?? []).map((i) => ({ item: i.item, amount: i.amount })),
          timeMinutes: m.timeMinutes ?? null,
          storeName: (plan.storeName as string | undefined) ?? "",
          plannedAt: plan.createdAt as string,
        });
        if (meals.length >= limit) break;
      }
      if (meals.length >= limit) break;
    }
    logger.info("Bloom meals", { uid, plans: plans.size, meals: meals.length, filling: toFill.length, filled: filledMacros.size });
    res.json({ linked: true, meals });
  }
);
