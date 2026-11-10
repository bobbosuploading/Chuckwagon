/**
 * Loads H-E-B everyday shelf prices through Apify (GitHub Actions, once a month).
 * Env: APIFY_TOKEN, HOME_ZIP (default 77437), GOOGLE_APPLICATION_CREDENTIALS.
 * DRY_RUN=1 prints prices without saving; MAX_ITEMS limits the run (a 20-item test costs about 14 cents).
 * HEB_PRICES_ENABLED=false turns the job off (do this before a paid launch; heb.com is scraped).
 */
import { appendFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { collectHebPrices } from "./hebPrices";

async function main() {
  if (process.env.HEB_PRICES_ENABLED === "false") {
    console.log("H-E-B prices are turned off (HEB_PRICES_ENABLED=false).");
    return;
  }
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.log("APIFY_TOKEN is not set; skipping H-E-B prices.");
    return;
  }
  const zip = process.env.HOME_ZIP || "77437";
  const dryRun = process.env.DRY_RUN === "1";
  const maxItems = process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : undefined;
  if (!dryRun) initializeApp();
  const { summary, items } = await collectHebPrices(token, zip, { dryRun, maxItems });
  const lines = [
    `H-E-B prices near ${zip}: ${summary.prices} products from ${summary.rows} rows at ${summary.store ?? "?"}${dryRun ? " (dry run, not saved)" : ""}`,
    ...items.slice(0, 80).map(
      (p) =>
        `  ${(p.category ?? "-").padEnd(8)} $${p.price.toFixed(2)}${p.soldBy === "WEIGHT" ? "/lb" : ""}${p.promo ? ` (sale $${p.promo.toFixed(2)})` : ""}  ${p.name}${p.size ? ` | ${p.size}` : ""}`
    ),
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
  if (items.length === 0) throw new Error("No H-E-B prices came back; check the Apify run");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
