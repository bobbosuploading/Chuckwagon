import { FieldValue, Firestore } from "firebase-admin/firestore";
import { cleanMealName, dislikedMealsFrom } from "./dislikedMeals";

/**
 * Meals a shopper marked as a "Keeper", kept on users/{uid}.likedMeals (newest last) with their
 * recipes, so the app's "Pick saved meals" list can show them first even after the plan they
 * came from is gone. Liking a meal takes it off dislikedMeals, and disliking one takes it off
 * this list (saveMealDisliked). The planner doesn't read this list, so it costs nothing per plan.
 */
export const MAX_LIKED_MEALS = 50;

export interface LikedMeal {
  name: string;
  servings: number;
  timeMinutes: number;
  ingredients: { item: string; amount: string; onSale?: boolean }[];
  steps: string[];
}

/** A meal's recipe as the app sent it, trimmed to sane sizes (it comes from the app, so check it). */
export function cleanLikedMeal(raw: unknown, name: string): LikedMeal {
  const m = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (v: unknown, len: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, len) : "");
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const whole = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fallback;
  const ingredients = list(m.ingredients)
    .map((raw) => {
      const i = (raw ?? {}) as Record<string, unknown>;
      const onSale = i.onSale === true || (typeof i.dealId === "string" && i.dealId.length > 0);
      return { item: text(i.item, 80), amount: text(i.amount, 40), ...(onSale ? { onSale: true } : {}) };
    })
    .filter((i) => i.item)
    .slice(0, 25);
  const steps = list(m.steps)
    .map((t) => text(t, 300))
    .filter(Boolean)
    .slice(0, 12);
  return {
    name,
    servings: whole(m.servings, 1, 12, 4),
    timeMinutes: whole(m.timeMinutes, 0, 600, 30),
    ingredients,
    steps,
  };
}

/** The saved list, cleaned (guards older or odd data). */
export function likedMealsFrom(raw: unknown): LikedMeal[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: LikedMeal[] = [];
  for (const m of raw) {
    const name = cleanMealName((m as Record<string, unknown>)?.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(cleanLikedMeal(m, name));
  }
  return out.slice(-MAX_LIKED_MEALS);
}

/** Both lists after a change, as the likeMeal and dislikeMeal callables return them. */
export interface MealRatings {
  likedMeals: LikedMeal[];
  dislikedMeals: string[];
}

/**
 * Adds a meal to the shopper's Keepers (liked = true, with its recipe) or takes it off (false).
 * Matching is case-insensitive. Liking a meal that's already there moves it to the end and
 * refreshes its recipe; the oldest drop off past MAX_LIKED_MEALS. Liking also takes the meal
 * off the disliked list. Returns both lists.
 */
export async function saveMealLiked(db: Firestore, uid: string, name: string, liked: boolean, recipe?: unknown): Promise<MealRatings> {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = name.toLowerCase();
    const likedList = likedMealsFrom(snap.get("likedMeals")).filter((m) => m.name.toLowerCase() !== key);
    let dislikedList = dislikedMealsFrom(snap.get("dislikedMeals"));
    const update: Record<string, unknown> = { likedMealsUpdatedAt: FieldValue.serverTimestamp() };
    if (liked) {
      likedList.push(cleanLikedMeal(recipe, name));
      const before = dislikedList.length;
      dislikedList = dislikedList.filter((n) => n.toLowerCase() !== key);
      if (dislikedList.length !== before) {
        update.dislikedMeals = dislikedList;
        update.dislikedMealsUpdatedAt = FieldValue.serverTimestamp();
      }
    }
    const likedMeals = likedList.slice(-MAX_LIKED_MEALS);
    tx.set(ref, { ...update, likedMeals }, { merge: true });
    return { likedMeals, dislikedMeals: dislikedList };
  });
}
