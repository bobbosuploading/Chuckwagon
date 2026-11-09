import { initializeApp } from "firebase-admin/app";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret, defineString } from "firebase-functions/params";
import * as logger from "firebase-functions/logger";
import { collectKrogerDeals } from "./collectKroger";

initializeApp();

const KROGER_CLIENT_ID = defineString("KROGER_CLIENT_ID");
const KROGER_CLIENT_SECRET = defineSecret("KROGER_CLIENT_SECRET");
const HOME_ZIP = defineString("HOME_ZIP", { default: "77437" });

/**
 * Collects Kroger sale items Monday, Wednesday and Friday at 6 AM Central.
 * To run it right away: Google Cloud console > Cloud Scheduler > this job > "Force run".
 */
export const collectKroger = onSchedule(
  {
    schedule: "0 6 * * 1,3,5",
    timeZone: "America/Chicago",
    secrets: [KROGER_CLIENT_SECRET],
    timeoutSeconds: 540,
    memory: "512MiB",
    retryCount: 1,
  },
  async () => {
    const summary = await collectKrogerDeals(KROGER_CLIENT_ID.value(), KROGER_CLIENT_SECRET.value(), HOME_ZIP.value());
    logger.info("Kroger collection finished", summary);
  }
);
