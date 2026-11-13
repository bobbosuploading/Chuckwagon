/**
 * Test the meal planner without the app. Used by the "Test meal plan" GitHub workflow.
 *
 * Env: ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS (Firebase service account),
 *      optional STORE_ID (defaults to the first store), MODEL, MEALS, HOUSEHOLD, DIET, DISLIKES, BUDGET,
 *      EXTRA (extra meal ideas; the summary then also shows a swap of the last main meal),
 *      STORE_IDS (more stores, comma-separated), VARIANTS (comma-separated thinking efforts to
 *      make the plan with, one after another, to compare timing and quality: medium, low, high).
 * Saves the plan to plans/{id} and prints a readable summary (also to the GitHub job summary).
 */
import { appendFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { chooseMeals, MealPlan, planMeals, PlanOptions, PlanRequest } from "./plan";

const VARIANTS: Record<string, Omit<PlanOptions, "model">> = {
  medium: {},
  low: { effort: "low" },
  high: { effort: "high" },
};

function timingTable(p: MealPlan, title: string): string {
  const t = p.usage.timingsMs;
  if (!t) return "";
  const sec = (ms?: number) => (ms === undefined ? "" : `${(ms / 1000).toFixed(1)} s`);
  const rows: string[] = [];
  for (let n = 1; t[`draft${n}`] !== undefined; n++) {
    rows.push(
      `| ${n === 1 ? "plan" : "budget redraft"} | ${sec(t[`draft${n}`])} | ${sec(t[`draft${n}Thinking`])} | ${t[`draft${n}OutputTokens`] ?? ""} |`,
      `| pricing everyday items | ${sec(t[`pricing${n}`])} | | |`
    );
  }
  return [
    `### ${title}: ${sec(t.total)} in all`,
    `Loading stores and deals: ${sec(t.loadDeals)}. Model: ${p.model}. Cost about $${p.usage.estimatedCostUsd ?? "?"}.`,
    "",
    "| Step | Time | Answer started after | Tokens written |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function toMarkdown(p: MealPlan): string {
  const out: string[] = [];
  out.push(`# Meal plan: ${p.storeName}`);
  out.push(
    `Model: \`${p.model}\` · ${p.usage.inputTokens} in / ${p.usage.outputTokens} out tokens · about $${p.usage.estimatedCostUsd ?? "?"}`
  );
  out.push("");
  p.meals.forEach((m, i) => {
    out.push(`## ${i + 1}. ${m.name} (${m.servings} servings, ${m.timeMinutes} min)`);
    out.push(m.ingredients.map((g) => `- ${g.amount} ${g.item}${g.dealId ? " **(on sale)**" : ""}`).join("\n"));
    out.push("");
    out.push(m.steps.map((s, j) => `${j + 1}. ${s}`).join("\n"));
    out.push("");
  });
  out.push("## Grocery list");
  let aisle = "";
  for (const li of [...p.groceryList].sort((a, b) => a.aisle.localeCompare(b.aisle))) {
    if (li.aisle !== aisle) out.push(`\n**${(aisle = li.aisle)}**`);
    const price = li.onSale
      ? ` · sale ${li.salePrice != null ? `$${li.salePrice.toFixed(2)}` : "(ad deal)"}${li.regularPrice != null ? ` (reg $${li.regularPrice.toFixed(2)})` : ""}${li.lineSavings ? `, save $${li.lineSavings.toFixed(2)}` : ""}`
      : li.lineTotal !== null
        ? ` · regular $${li.lineTotal.toFixed(2)}${li.priceSource === "estimate" ? " (estimate)" : ""} as ${li.pricedAs}`
        : " · regular price (no price found)";
    out.push(`- [ ] ${li.item}, ${li.quantityNote} (buy ${li.buyCount})${price}`);
  }
  out.push("");
  out.push(
    `**Sale items: $${p.totals.saleItems.toFixed(2)} · Regular items: $${p.totals.regularItems.toFixed(2)} · Estimated total: $${p.totals.estimatedTotal.toFixed(2)} · You save: $${p.totals.savings.toFixed(2)}** (${p.totals.itemsNotPriced} items not priced)`
  );
  if (p.totals.perServing != null) out.push(`About $${p.totals.perServing.toFixed(2)} per serving.`);
  if (p.budget) {
    const b = p.budget;
    out.push(
      `**Budget $${b.amount.toFixed(2)}: ${b.fits ? `fits, $${b.left.toFixed(2)} left` : `over by $${(-b.left).toFixed(2)}`}**${b.revised ? " (trimmed after the first try came in over)" : ""}`
    );
  }
  if (p.notes) out.push(`\n> ${p.notes}`);
  return out.join("\n");
}

async function main() {
  initializeApp();
  const db = getFirestore();
  let storeId = process.env.STORE_ID;
  if (!storeId) {
    const first = await db.collection("stores").limit(1).get();
    if (first.empty) throw new Error("No stores in Firestore yet; run the deal collector first");
    storeId = first.docs[0].id;
  }
  const num = (v?: string) => (v ? Number(v) : undefined);
  const req: PlanRequest = {
    storeId,
    storeIds: [storeId, ...(process.env.STORE_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean)],
    mealCount: num(process.env.MEALS),
    householdSize: num(process.env.HOUSEHOLD),
    diet: process.env.DIET,
    dislikes: process.env.DISLIKES,
    budget: num(process.env.BUDGET),
    extraMeals: num(process.env.EXTRA),
  };
  const anthropic = new Anthropic();
  const model = process.env.MODEL || undefined;
  let md = "";
  // Extra variants run first, back to back, so they see the same deals and nearly the same service speed.
  const variants = (process.env.VARIANTS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  const summary: string[] = [];
  for (const v of variants.slice(0, -1)) {
    if (!VARIANTS[v]) throw new Error(`Unknown variant ${v}`);
    try {
      const p = await planMeals(db, anthropic, req, { model, ...VARIANTS[v] });
      summary.push(timingTable(p, `Variant "${v}"`));
      md += `# Variant "${v}"\n\n${toMarkdown(p)}\n\n---\n\n`;
    } catch (err) {
      summary.push(`### Variant "${v}" failed: ${(err as Error).message}\n`);
    }
  }
  const last = variants[variants.length - 1];
  if (last && !VARIANTS[last]) throw new Error(`Unknown variant ${last}`);
  // Log each progress update with how long after the start it came, to check meals show up early.
  const started = Date.now();
  const onProgress = (pr: { stage: string; meals: { name: string; extra: boolean }[] }) =>
    console.log(`[progress ${((Date.now() - started) / 1000).toFixed(1)} s] ${pr.stage}: ${pr.meals.map((m) => m.name + (m.extra ? " (extra)" : "")).join(", ")}`);
  const plan = await planMeals(db, anthropic, req, { model, onProgress, ...(last ? VARIANTS[last] : {}) });
  summary.push(timingTable(plan, last ? `Variant "${last}"` : "This plan"));
  const ref = await db.collection("plans").add({ ...plan, uid: "test" });
  md = `${summary.join("\n")}\n---\n\n${md}${last ? `# Variant "${last}"\n\n` : ""}${toMarkdown(plan)}\n\n_Saved as plans/${ref.id}_\n`;
  const opts = plan.options;
  if (opts) {
    const extras = opts.meals.filter((m) => !opts.chosen.includes(m.name));
    md += `\n## Extra meal ideas\n${extras.map((m) => `- ${m.name} (${m.servings} servings, ${m.timeMinutes} min)`).join("\n")}\n`;
    // Show what a swap does: drop the last main meal, pick the first extra.
    const swapped = [...opts.chosen.slice(0, -1), extras[0].name];
    const after = { ...plan, ...chooseMeals(plan, swapped) };
    md += `\n---\n\n# After swapping "${opts.chosen[opts.chosen.length - 1]}" for "${extras[0].name}"\n\n${toMarkdown(after)}\n`;
  }
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
