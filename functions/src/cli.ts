/**
 * Runs the Kroger collection outside Cloud Functions (GitHub Actions or a Mac),
 * because Kroger's bot protection blocks requests from Google Cloud.
 *
 * Needs these environment variables:
 *   KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, HOME_ZIP (optional, default 77437)
 *   AREA_ZIPS (optional, comma-separated) to use instead of the registered areas in Firestore
 *   DRY_RUN=1 to only count deals and prices without writing anything
 *   GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { collectKrogerDeals } from "./collectKroger";
import { loadAreaZips } from "./regions";

async function main() {
  const id = process.env.KROGER_CLIENT_ID;
  const secret = process.env.KROGER_CLIENT_SECRET;
  const zip = process.env.HOME_ZIP || "77437";
  if (!id || !secret) throw new Error("KROGER_CLIENT_ID and KROGER_CLIENT_SECRET must be set");
  initializeApp();
  const zips = await loadAreaZips(getFirestore(), zip);
  const summary = await collectKrogerDeals(id, secret, zips, process.env.DRY_RUN === "1");
  console.log(JSON.stringify(summary, null, 2));
  if (summary.stores === 0 || summary.deals === 0) {
    throw new Error("No stores or no deals collected; check the log above");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
