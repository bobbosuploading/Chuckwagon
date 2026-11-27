import { FieldValue, Firestore } from "firebase-admin/firestore";
import { cleanMealName } from "./dislikedMeals";

/**
 * A shopper's own notes on meals ("used twice the garlic", "add a can of green chiles"), kept on
 * users/{uid}.mealNotes (newest last). They're private: only the shopper reads them, the app shows
 * a note again wherever that meal turns up, and the planner gets the most recent few in its prompt
 * (mealNotesText) so it can follow them when it suggests that meal again.
 */
export const MAX_MEAL_NOTES = 100;
export const MAX_NOTE_LENGTH = 500;
/** Only this many notes, each cut to PROMPT_NOTE_LENGTH, go into a plan's prompt, to keep it cheap. */
export const PROMPT_NOTES = 12;
const PROMPT_NOTE_LENGTH = 200;

export interface MealNote {
  name: string;
  note: string;
}

/** A note as it's saved: plain text, line breaks kept (at most a few), no control characters. */
export function cleanNote(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[^\P{C}\n]/gu, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTE_LENGTH)
    .trim();
}

/** The saved list, cleaned (guards older or odd data), each meal once. */
export function mealNotesFrom(raw: unknown): MealNote[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: MealNote[] = [];
  // Newest last, so read from the end and keep the latest note for each meal.
  for (const m of [...raw].reverse()) {
    const r = (m ?? {}) as Record<string, unknown>;
    const name = cleanMealName(r.name);
    const note = cleanNote(r.note);
    if (!name || !note || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, note });
  }
  return out.reverse().slice(-MAX_MEAL_NOTES);
}

/**
 * The prompt lines, or "" when there are none (so plans without notes cost nothing extra). Notes
 * on meals the shopper picked to include come first, then the newest, up to PROMPT_NOTES, one line each.
 */
export function mealNotesText(notes: MealNote[], includeNames: string[] = []): string {
  const included = new Set(includeNames.map((n) => cleanMealName(n).toLowerCase()));
  const first = notes.filter((n) => included.has(n.name.toLowerCase()));
  const rest = notes.filter((n) => !included.has(n.name.toLowerCase()));
  const chosen = new Set([...first, ...rest.slice(-Math.max(0, PROMPT_NOTES - first.length))].slice(0, PROMPT_NOTES));
  // Keep the saved order (oldest first) so the prompt reads the same way every time.
  const recent = notes.filter((n) => chosen.has(n));
  if (!recent.length) return "";
  const lines = recent.map((n) => {
    const note = n.note.replace(/\s+/g, " ").slice(0, PROMPT_NOTE_LENGTH).trim();
    return `- ${n.name}: ${note}`;
  });
  return `SHOPPER'S OWN NOTES ON MEALS THEY'VE COOKED (if you suggest or include one of these meals, work its note into the recipe; also treat them as hints about how this household likes to cook; they never override allergies or the diet):\n${lines.join("\n")}\n`;
}

/**
 * Saves a note on a meal, or deletes it when the note is empty. Matching is case-insensitive.
 * A changed note moves to the end, and the oldest drop off past MAX_MEAL_NOTES. Returns the list.
 */
export async function saveMealNote(db: Firestore, uid: string, name: string, note: string): Promise<MealNote[]> {
  const ref = db.collection("users").doc(uid);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const key = name.toLowerCase();
    const list = mealNotesFrom(snap.get("mealNotes")).filter((n) => n.name.toLowerCase() !== key);
    if (note) list.push({ name, note });
    const mealNotes = list.slice(-MAX_MEAL_NOTES);
    tx.set(ref, { mealNotes, mealNotesUpdatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return mealNotes;
  });
}
