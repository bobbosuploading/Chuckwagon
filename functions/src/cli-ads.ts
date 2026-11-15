/**
 * Loads the current ALDI, Dollar General and Lowe's Market weekly ads into Firestore (GitHub Actions).
 * HOME_ZIP (default 77437); AREA_ZIPS (optional, comma-separated) instead of the registered areas.
 * DRY_RUN=1 prints the deals without writing.
 * GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file (not needed for a dry run).
 */
import { appendFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { collectFlippAds } from "./collectFlippAds";
import { loadAreaZips } from "./regions";

async function main() {
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  const canRead = !dryRun || !!process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (canRead) initializeApp();
  const zips = await loadAreaZips(canRead ? getFirestore() : null, zip);
  const { merchantsSeen, results } = await collectFlippAds(zips, undefined, dryRun);
  const out: string[] = [`Areas: ${zips.join(", ")}`, `Flipp merchants: ${merchantsSeen.join(", ")}`, ""];
  for (const { summary, deals } of results) {
    const shared = summary.sharedWith.length ? `, same ad for ${summary.sharedWith.join(", ")}` : "";
    out.push(`## ${summary.storeId}: ${summary.deals} deals${shared}${dryRun ? " (dry run, not saved)" : ""}`);
    for (const f of summary.flyers) out.push(`- flyer ${f.id} ${f.name ?? ""} ${f.validFrom.slice(0, 10)} to ${f.validTo.slice(0, 10)}`);
    for (const d of deals.slice(0, 60)) {
      const price = d.salePrice !== null ? `$${d.salePrice}${d.soldBy === "WEIGHT" ? "/lb" : ""}` : "promo";
      out.push(`    ${d.category.padEnd(9)} ${price.padEnd(9)} ${d.name}${d.promo ? `  [${d.promo.slice(0, 80)}]` : ""}`);
    }
    out.push("");
  }
  const text = out.join("\n");
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + text + "\n```\n");
  if (results.every((r) => r.summary.deals === 0)) throw new Error("No ALDI, Dollar General or Lowe's Market ad items found");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
