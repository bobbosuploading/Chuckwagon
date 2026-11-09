/**
 * Runs the Kroger collection outside Cloud Functions (GitHub Actions or a Mac),
 * because Kroger's bot protection blocks requests from Google Cloud.
 *
 * Needs these environment variables:
 *   KROGER_CLIENT_ID, KROGER_CLIENT_SECRET, HOME_ZIP (optional, default 77437)
 *   GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file
 */
import { initializeApp } from "firebase-admin/app";
import { collectKrogerDeals } from "./collectKroger";

async function main() {
  const id = process.env.KROGER_CLIENT_ID;
  const secret = process.env.KROGER_CLIENT_SECRET;
  const zip = process.env.HOME_ZIP || "77437";
  if (!id || !secret) throw new Error("KROGER_CLIENT_ID and KROGER_CLIENT_SECRET must be set");
  initializeApp();
  const summary = await collectKrogerDeals(id, secret, zip);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.stores === 0 || summary.deals === 0) {
    throw new Error("No stores or no deals collected; check the log above");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
