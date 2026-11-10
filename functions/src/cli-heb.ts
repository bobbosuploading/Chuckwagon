/**
 * Loads the current H-E-B weekly ad into Firestore (GitHub Actions).
 * HOME_ZIP (default 77437); AREA_ZIPS (optional, comma-separated) instead of the registered areas.
 * DRY_RUN=1 prints the deals without writing.
 * GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file (not needed for a dry run).
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { collectHebDeals } from "./collectHeb";
import { loadAreaZips } from "./regions";

async function main() {
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  const canRead = !dryRun || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (canRead) initializeApp();
  const zips = await loadAreaZips(canRead ? getFirestore() : null, zip);
  const { summary, deals } = await collectHebDeals(zips, dryRun, zip);
  console.log(JSON.stringify(summary, null, 2));
  for (const d of deals) {
    const price = d.salePrice !== null ? `$${d.salePrice}${d.soldBy === "WEIGHT" ? "/lb" : ""}` : "promo";
    const promo = d.promo ? `  [${d.promo.slice(0, 90)}]` : "";
    console.log(`${d.category.padEnd(9)} ${price.padEnd(9)} ${d.name}${promo}`);
  }
  if (deals.length === 0) throw new Error("No H-E-B deals found");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
