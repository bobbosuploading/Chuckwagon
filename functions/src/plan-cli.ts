/**
 * Test the meal planner without the app. Used by the "Test meal plan" GitHub workflow.
 *
 * Env: ANTHROPIC_API_KEY, GOOGLE_APPLICATION_CREDENTIALS (Firebase service account),
 *      optional STORE_ID (defaults to the first store), MODEL, MEALS, HOUSEHOLD, DIET, DISLIKES, BUDGET.
 * Saves the plan to plans/{id} and prints a readable summary (also to the GitHub job summary).
 */
import { appendFileSync } from "node:fs";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";
import { MealPlan, planMeals } from "./plan";

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
  const plan = await planMeals(
    db,
    new Anthropic(),
    {
      storeId,
      mealCount: num(process.env.MEALS),
      householdSize: num(process.env.HOUSEHOLD),
      diet: process.env.DIET,
      dislikes: process.env.DISLIKES,
      budget: num(process.env.BUDGET),
    },
    process.env.MODEL || undefined
  );
  const ref = await db.collection("plans").add({ ...plan, uid: "test" });
  const md = toMarkdown(plan) + `\n\n_Saved as plans/${ref.id}_\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
