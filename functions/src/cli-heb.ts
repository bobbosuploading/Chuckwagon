/**
 * Loads the current H-E-B weekly ad into Firestore (GitHub Actions).
 * HOME_ZIP (default 77437); DRY_RUN=1 prints the deals without writing.
 * GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file (not needed for a dry run).
 */
import { initializeApp } from "firebase-admin/app";
import { collectHebDeals } from "./collectHeb";

async function main() {
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun) initializeApp();
  const { summary, deals } = await collectHebDeals(zip, dryRun);
  console.log(JSON.stringify(summary, null, 2));
  for (const d of deals) {
    const price = d.salePrice !== null ? `$${d.salePrice}${d.soldBy === "WEIGHT" ? "/lb" : ""}` : "promo";
    const promo = d.promo ? `  [${d.promo.slice(0, 90)}]` : "";
    console.log(`${d.category.padEnd(9)} ${price.padEnd(9)} ${d.name}${promo}  pct=${JSON.stringify(d.pctOff)} reg=${JSON.stringify(d.regularPrice)} save=${JSON.stringify(d.savings)}`);
  }
  if (deals.length === 0) throw new Error("No H-E-B deals found");
  if (dryRun && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    // Diagnostic: what is stored for this store right now.
    const { getFirestore } = await import("firebase-admin/firestore");
    initializeApp();
    const snap = await getFirestore().collection("deals").where("storeId", "==", `heb-${zip}`).get();
    console.log(`stored: ${snap.size}`);
    for (const doc of snap.docs) {
      const x = doc.data();
      const types = Object.entries(x).map(([k, v]) => `${k}:${v === null ? "null" : typeof v}`).join(",");
      console.log(`${doc.id} pct=${JSON.stringify(x.pctOff)} ${types}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
