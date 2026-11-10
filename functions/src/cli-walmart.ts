/**
 * Prices Walmart's common grocery items for the home ZIP and saves deals (GitHub Actions).
 *
 * Environment:
 *   WALMART_CONSUMER_ID, WALMART_PRIVATE_KEY (PEM text), WALMART_KEY_VERSION (default 1)
 *   WALMART_PUBLISHER_ID (optional, Impact publisher ID)
 *   HOME_ZIP (default 77437); DRY_RUN=1 prints prices without writing.
 *   GOOGLE_APPLICATION_CREDENTIALS = Firebase service account JSON file (not needed for a dry run).
 */
import { initializeApp } from "firebase-admin/app";
import { collectWalmartDeals } from "./collectWalmart";

async function main() {
  const consumerId = process.env.WALMART_CONSUMER_ID;
  // GitHub secrets sometimes keep "\n" literally; turn them back into line breaks.
  const privateKey = process.env.WALMART_PRIVATE_KEY?.replace(/\\n/g, "\n");
  if (!consumerId || !privateKey) throw new Error("WALMART_CONSUMER_ID and WALMART_PRIVATE_KEY must be set");
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun) initializeApp();

  const { summary, deals, priced } = await collectWalmartDeals(
    {
      consumerId,
      privateKey,
      keyVersion: process.env.WALMART_KEY_VERSION || "1",
      publisherId: process.env.WALMART_PUBLISHER_ID || undefined,
    },
    zip,
    dryRun
  );
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nDeals (${deals.length}):`);
  for (const d of deals) {
    const was = d.regularPrice ? ` (was $${d.regularPrice})` : "";
    console.log(`${d.category.padEnd(9)} $${String(d.salePrice).padEnd(7)}${was.padEnd(14)} ${d.name}  [${d.promo}]`);
  }
  if (dryRun) {
    console.log(`\nAll prices (${priced.length}):`);
    for (const it of priced) console.log(`$${String(it.salePrice).padEnd(7)} ${it.offerType ?? ""} ${it.name}`);
  }
  if (summary.priced === 0) throw new Error("No Walmart prices came back; check the errors above");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
