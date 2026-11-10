import { defineBoolean } from "firebase-functions/params";
import { CallableRequest, HttpsError } from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

/**
 * App Check rollout switch. Set the GitHub repo variable APP_CHECK_ENFORCE to "true"
 * and run the deploy workflow once the App Check build is on everyone's phone.
 * While it is false, calls without an App Check token still work but are logged,
 * so old TestFlight builds keep working during the switch-over.
 */
const APP_CHECK_ENFORCE = defineBoolean("APP_CHECK_ENFORCE", { default: false });

/**
 * Call at the top of every callable function. Firebase already rejects bad App Check
 * tokens when enforcing; this handles calls that sent no token at all.
 */
export function requireApp(request: CallableRequest, fn: string): void {
  if (request.app) return;
  if (APP_CHECK_ENFORCE.value()) {
    logger.warn("Blocked call without App Check", { fn, uid: request.auth?.uid });
    throw new HttpsError("failed-precondition", "Please update Chuckwagon to the latest version.");
  }
  logger.info("Call without App Check (allowed during rollout)", { fn, uid: request.auth?.uid });
}
