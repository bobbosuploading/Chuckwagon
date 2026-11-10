/**
 * Loads the current ALDI and Dollar General weekly ads into Firestore (GitHub Actions).
 * HOME_ZIP (default 77437); DRY_RUN=1 prints the deals without writing.
 * GOOGLE_APPLICATION_CREDENTIALS = path to a Firebase service account JSON file (not needed for a dry run).
 */
import { appendFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { collectFlippAds } from "./collectFlippAds";

async function main() {
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  if (!dryRun) initializeApp();
  const { merchantsSeen, results } = await collectFlippAds(zip, undefined, dryRun);
  const out: string[] = [`Flipp merchants near ${zip}: ${merchantsSeen.join(", ")}`, ""];
  for (const { summary, deals } of results) {
    out.push(`## ${summary.chain}: ${summary.deals} deals${dryRun ? " (dry run, not saved)" : ""}`);
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
  if (results.every((r) => r.summary.deals === 0)) throw new Error("No ALDI or Dollar General ad items found");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
