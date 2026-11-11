/**
 * Builds the Sam's Club stock-up list through Apify (GitHub Actions, once a month).
 * Env: APIFY_TOKEN, ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS.
 * DRY_RUN=1 prints what came back without saving or comparing; MAX_ITEMS limits the run;
 * TERMS (comma separated) searches only those staples.
 * SAMS_PRICES_ENABLED=false turns the job off (do this before a paid launch; samsclub.com is scraped).
 */
import { appendFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { initializeApp } from "firebase-admin/app";
import { collectSamsClub } from "./clubPrices";

async function main() {
  if (process.env.SAMS_PRICES_ENABLED === "false") {
    console.log("Sam's Club prices are turned off (SAMS_PRICES_ENABLED=false).");
    return;
  }
  const token = process.env.APIFY_TOKEN;
  if (!token) {
    console.log("APIFY_TOKEN is not set; skipping Sam's Club prices.");
    return;
  }
  const dryRun = process.env.DRY_RUN === "1";
  const maxItems = process.env.MAX_ITEMS ? Number(process.env.MAX_ITEMS) : undefined;
  const terms = process.env.TERMS ? process.env.TERMS.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  if (!dryRun) initializeApp();
  const { summary, items, rows } = await collectSamsClub(token, dryRun ? null : new Anthropic(), { dryRun, maxItems, terms });
  const per = (u: string) => (u === "lb" ? "/lb" : u === "ct" ? " each" : "/fl oz");
  const lines = [
    `Sam's Club: ${summary.items} usable items from ${summary.rows} rows${dryRun ? " (dry run, not saved)" : `, ${summary.compared} compared, ${summary.worthIt} worth the trip`}`,
    ...items.slice(0, 150).map((i) => {
      const cmp = i.compare.map((c) => `${c.chain} $${c.unitPrice.toFixed(2)} (${c.product.slice(0, 40)})`).join("; ");
      return `  ${i.category.padEnd(8)} $${i.price.toFixed(2)} = $${i.unitPrice.toFixed(2)}${per(i.unit)}  ${i.name}${i.pctCheaper !== null ? `  [${i.pctCheaper}% cheaper] ${cmp}` : ""}`;
    }),
  ];
  console.log(lines.join("\n"));
  if (dryRun) {
    console.log("\nFirst raw rows:");
    for (const r of rows.slice(0, 3)) console.log(JSON.stringify(r).slice(0, 1500));
    console.log("\nAll row names:");
    for (const r of rows) console.log(`  ${String(r.price)}  ${String(r.name ?? r.title)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
  if (rows.length === 0) throw new Error("No Sam's Club rows came back; check the Apify run");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
