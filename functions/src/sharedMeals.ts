/**
 * "Share a meal" / "Share this plan": copies one meal, or a whole plan's meals and grocery list,
 * into sharedMeals/{id} and returns a link (https://chuckwagon-ebbcc.web.app/m/{id}).
 *
 * Only a copy is shared. It never holds the sender's user id, settings, check marks or other
 * plans, so anyone with the link can open it (the app reads it from Firestore; people without
 * the app get the web page from sharePage below). Ids are random, and the rules allow reading
 * one shared item by id but not listing them.
 */
import { createHash, randomBytes } from "node:crypto";
import { FieldValue, Firestore } from "firebase-admin/firestore";
import type { MealPlan, PricedListItem } from "./plan";

/** Where shared links point. Firebase Hosting's free address for the project. */
export const SHARE_HOST = "chuckwagon-ebbcc.web.app";
/** The app's own link scheme, for the web page's "Open in Chuckwagon" button. */
export const APP_SCHEME = "chuckwagon";
/** Anyone can join the beta from here, for people who don't have the app yet. */
export const TESTFLIGHT_URL = "https://testflight.apple.com/join/cvCJVKR3";

export class MealShareError extends Error {}

export interface SharedMeal {
  name: string;
  servings: number;
  timeMinutes: number;
  ingredients: { item: string; amount: string; onSale: boolean }[];
  steps: string[];
}

export interface SharedListItem {
  aisle: string;
  item: string;
  quantityNote: string;
  buyCount: number;
  onSale: boolean;
  salePrice: number | null;
  lineTotal: number | null;
  storeName: string | null;
  forMeals: string[];
}

/** What sharedMeals/{id} holds. */
export interface SharedMeals {
  /** "meal" for one recipe, "plan" for a plan's meals and grocery list. */
  kind: "meal" | "plan";
  title: string;
  /** The store the plan was made for, so "ON SALE" makes sense to the person opening it. */
  storeName: string;
  meals: SharedMeal[];
  /** Plans only. */
  groceryList: SharedListItem[] | null;
  /** Plans only: the estimated total and savings when it was shared. */
  totals: { estimatedTotal: number | null; savings: number } | null;
  createdAt: string;
}

const ID_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
export const SHARE_ID = /^[A-Za-z0-9]{10}$/;

/** 10 random letters and digits (about 58 bits), so links can't be guessed. */
function newShareId(): string {
  const bytes = randomBytes(10);
  return [...bytes].map((b) => ID_CHARS[b % ID_CHARS.length]).join("");
}

export function shareUrl(id: string): string {
  return `https://${SHARE_HOST}/m/${id}`;
}

function copyMeal(m: MealPlan["meals"][number]): SharedMeal {
  return {
    name: m.name,
    servings: m.servings,
    timeMinutes: m.timeMinutes,
    ingredients: m.ingredients.map((i) => ({ item: i.item, amount: i.amount, onSale: !!i.dealId })),
    steps: m.steps,
  };
}

function copyListItem(li: PricedListItem): SharedListItem {
  return {
    aisle: li.aisle,
    item: li.item,
    quantityNote: li.quantityNote,
    buyCount: li.buyCount,
    onSale: li.onSale,
    salePrice: li.salePrice ?? null,
    lineTotal: li.lineTotal ?? null,
    storeName: li.storeName ?? null,
    forMeals: li.forMeals ?? [],
  };
}

/**
 * Shares one meal from a plan (any of its ideas, picked or not), or the plan's picked meals and
 * grocery list when `mealName` is empty. Sharing the same thing again returns the same link.
 */
export async function shareMeals(
  db: Firestore,
  uid: string,
  planId: string,
  mealName: string | undefined
): Promise<{ id: string; url: string; title: string }> {
  const planRef = db.collection("plans").doc(planId);
  const snap = await planRef.get();
  if (!snap.exists || snap.get("uid") !== uid) throw new MealShareError("That plan wasn't found.");
  const plan = snap.data() as MealPlan & { shares?: Record<string, string> };

  let doc: Omit<SharedMeals, "createdAt">;
  if (mealName) {
    const all = plan.options?.meals ?? plan.meals;
    const meal = all.find((m) => m.name === mealName);
    if (!meal) throw new MealShareError("That meal isn't in this plan anymore.");
    doc = { kind: "meal", title: meal.name, storeName: plan.storeName, meals: [copyMeal(meal)], groceryList: null, totals: null };
  } else {
    const names = plan.meals.map((m) => m.name);
    doc = {
      kind: "plan",
      title: `${names.length} supper${names.length === 1 ? "" : "s"} from ${plan.storeName}`,
      storeName: plan.storeName,
      meals: plan.meals.map(copyMeal),
      groceryList: plan.groceryList.map(copyListItem),
      totals: { estimatedTotal: plan.totals.estimatedTotal ?? null, savings: plan.totals.savings },
    };
  }

  // The same meal, or the same set of picked meals, keeps its link.
  const key = createHash("sha1")
    .update(doc.kind === "meal" ? `meal:${mealName}` : `plan:${doc.meals.map((m) => m.name).join("|")}`)
    .digest("hex")
    .slice(0, 16);
  const existing = plan.shares?.[key];
  if (existing && (await db.collection("sharedMeals").doc(existing).get()).exists) {
    return { id: existing, url: shareUrl(existing), title: doc.title };
  }

  const id = newShareId();
  // Firestore rejects undefined values, so round-trip through JSON.
  const data: SharedMeals = JSON.parse(JSON.stringify({ ...doc, createdAt: new Date().toISOString() }));
  await db.collection("sharedMeals").doc(id).set(data);
  await planRef.update({ [`shares.${key}`]: id });
  // Who shared what stays backend-only, for abuse checks.
  await db.collection("mealShareLog").doc(id).set({ uid, planId, kind: doc.kind, createdAt: FieldValue.serverTimestamp() });
  return { id, url: shareUrl(id), title: doc.title };
}

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const money = (n: number | null | undefined) => (typeof n === "number" ? `$${n.toFixed(2)}` : "");

/** The page someone sees when they open a shared link without the app (or before it opens). */
export function sharePageHtml(id: string, shared: SharedMeals | null): string {
  const title = shared ? shared.title : "Shared meal not found";
  const description = shared
    ? shared.kind === "meal"
      ? `A supper idea from Chuckwagon: ${shared.meals[0]?.timeMinutes ?? ""} minutes, serves ${shared.meals[0]?.servings ?? ""}.`
      : `A meal plan from Chuckwagon: ${shared.meals.map((m) => m.name).join(", ")}.`
    : "This link may have been mistyped.";
  const meals = (shared?.meals ?? [])
    .map(
      (m) => `<section class="card">
  <h2>${esc(m.name)}</h2>
  <p class="meta">${esc(m.timeMinutes)} min · serves ${esc(m.servings)}</p>
  <h3>Ingredients</h3>
  <ul>${m.ingredients.map((i) => `<li>${esc(i.amount)} ${esc(i.item)}${i.onSale ? ' <span class="tag">ON SALE</span>' : ""}</li>`).join("")}</ul>
  <h3>Steps</h3>
  <ol>${m.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
</section>`
    )
    .join("\n");
  const list = shared?.groceryList?.length
    ? `<section class="card">
  <h2>Grocery list</h2>
  <ul class="list">${shared.groceryList
    .map((li) => `<li><span>${esc(li.item)} <small>${esc(li.quantityNote)}</small></span><span>${li.onSale ? money(li.salePrice) : money(li.lineTotal)}</span></li>`)
    .join("")}</ul>
  ${shared.totals?.estimatedTotal ? `<p class="meta">About ${money(shared.totals.estimatedTotal)} in all when it was shared.</p>` : ""}
</section>`
    : "";
  const saleNote = shared ? `<p class="meta">Sale prices were at ${esc(shared.storeName)} that week.</p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Chuckwagon</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:site_name" content="Chuckwagon">
<meta name="robots" content="noindex">
<style>
  :root { --cream: #FBF4E6; --ink: #2B2118; --red: #C8402F; --mustard: #E9B949; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--cream); color: var(--ink); font: 17px/1.45 -apple-system, system-ui, sans-serif; }
  main { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 28px; margin: 4px 0 4px; }
  h2 { font-size: 21px; margin: 0 0 4px; }
  h3 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; opacity: .6; margin: 16px 0 4px; }
  .brand { color: var(--red); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; font-size: 13px; }
  .meta { opacity: .65; font-size: 15px; margin: 4px 0; }
  .card { background: #fff; border-radius: 16px; padding: 16px; margin: 16px 0; }
  .tag { background: var(--mustard); border-radius: 99px; font-size: 11px; font-weight: 800; padding: 2px 6px; }
  .buttons { display: flex; flex-direction: column; gap: 10px; margin: 16px 0; }
  .btn { display: block; text-align: center; padding: 14px; border-radius: 14px; font-weight: 700; text-decoration: none; }
  .primary { background: var(--red); color: #fff; }
  .secondary { background: #fff; color: var(--ink); }
  ul, ol { padding-left: 22px; margin: 4px 0; }
  .list { list-style: none; padding: 0; }
  .list li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 0; border-bottom: 1px solid #eee; }
  small { opacity: .6; }
</style>
</head>
<body>
<main>
  <div class="brand">Chuckwagon</div>
  <h1>${esc(title)}</h1>
  ${saleNote}
  <div class="buttons">
    ${shared ? `<a class="btn primary" href="${APP_SCHEME}://m/${esc(id)}">Open in Chuckwagon</a>` : ""}
    <a class="btn secondary" href="${TESTFLIGHT_URL}">Get Chuckwagon (free beta)</a>
  </div>
  ${meals}
  ${list}
</main>
</body>
</html>`;
}

/** Apple's file that lets links to /m/... open the app (universal links). Needs the Apple Team ID. */
export function appSiteAssociation(teamId: string) {
  return {
    applinks: {
      details: [
        {
          appIDs: [`${teamId}.com.bobby.chuckwagon`, `${teamId}.com.bobby.chuckwagon.dev`],
          components: [{ "/": "/m/*", comment: "Shared meals and plans" }],
        },
      ],
    },
  };
}
