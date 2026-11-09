import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
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
    try {
      const db = getFirestore();
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
