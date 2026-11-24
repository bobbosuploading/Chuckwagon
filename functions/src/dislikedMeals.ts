import { FieldValue, Firestore } from "firebase-admin/firestore";

/**
 * Meals a shopper marked "Don't suggest again", kept on users/{uid}.dislikedMeals (newest last).
 * The planner gets them in its prompt (dislikedMealsText) so new plans skip those meals and
 * close versions of them. Only a short list is kept, so the prompt stays small and cheap.
 */
export const MAX_DISLIKED_MEALS = 30;
const MAX_NAME_LENGTH = 80;

/** A meal name as it goes into the list and the prompt: plain text, one line, not too long. */
export function cleanMealName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[^\p{L}\p{N} ,.'&()/-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME_LENGTH)
    .trim();
}

/** The saved list, cleaned (names are also cleaned when saved; this guards older or odd data). */
export function dislikedMealsFrom(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(cleanMealName).filter(Boolean).slice(-MAX_DISLIKED_MEALS);
}

/** The prompt line, or "" when there are none (so plans without dislikes cost nothing extra). */
export function dislikedMealsText(names: string[]): string {
  if (!names.length) return "";
  return `MEALS THE SHOPPER DISLIKES (never suggest these or close versions of them, extras included): ${names.join("; ")}\n`;
}

/**
 * Adds a meal to the shopper's list (disliked = true) or takes it off (false). Matching is
 * case-insensitive. Adding a meal that's already there moves it to the end, and the oldest
 * drop off past MAX_DISLIKED_MEALS. Returns the new list.
 */
export async function saveMealDisliked(db: Firestore, uid: string, name: string, disliked: boolean): Promise<string[]> {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = name.toLowerCase();
    const list = dislikedMealsFrom(snap.get("dislikedMeals")).filter((n) => n.toLowerCase() !== key);
    if (disliked) list.push(name);
    const next = list.slice(-MAX_DISLIKED_MEALS);
    tx.set(ref, { dislikedMeals: next, dislikedMealsUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return next;
  });
}
