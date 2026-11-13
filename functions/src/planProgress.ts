/**
 * Live progress for a meal plan, so the app can show meals as the planner writes them
 * instead of a spinner for a minute or more.
 *
 * The planner's answer streams in as JSON ({"meals":[{...},{...}],"groceryList":[...]}).
 * MealStreamReader picks out each meal the moment its object is complete.
 */

export type PlanStage =
  /** Reading deals and thinking; nothing written yet. */
  | "thinking"
  /** Meals are arriving. */
  | "meals"
  /** All meals are in; the grocery list is being written. */
  | "list"
  /** Pricing the everyday items on the list. */
  | "pricing"
  /** The first plan came in over budget; a cheaper one is being made. */
  | "budget";

export interface ProgressMeal {
  name: string;
  timeMinutes: number;
  /** One of the extra ideas to swap in, not a main meal. */
  extra: boolean;
}

export interface PlanProgress {
  stage: PlanStage;
  meals: ProgressMeal[];
}

/**
 * Reads complete meal objects out of the planner's streamed JSON. Feed it the whole answer
 * so far (the stream's snapshot) each time; it only scans what's new.
 */
export class MealStreamReader {
  private pos = 0;
  /** Index just after the "[" that opens the meals array, once found. */
  private arrayStart = -1;
  private depth = 0;
  private inString = false;
  private escaped = false;
  private objectStart = -1;
  /** True once the meals array has closed. */
  done = false;
  readonly meals: { name: string; timeMinutes: number }[] = [];

  /** Returns how many new meals were found. */
  read(text: string): number {
    const before = this.meals.length;
    if (this.arrayStart < 0) {
      const m = /"meals"\s*:\s*\[/.exec(text);
      if (!m) return 0;
      this.arrayStart = m.index + m[0].length;
      this.pos = this.arrayStart;
    }
    for (; this.pos < text.length && !this.done; this.pos++) {
      const c = text[this.pos];
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (c === "\\") this.escaped = true;
        else if (c === '"') this.inString = false;
        continue;
      }
      if (c === '"') this.inString = true;
      else if (c === "{" || c === "[") {
        if (this.depth === 0 && c === "{") this.objectStart = this.pos;
        this.depth++;
      } else if (c === "}" || c === "]") {
        if (this.depth === 0) {
          // The "]" that closes the meals array.
          this.done = true;
          break;
        }
        this.depth--;
        if (this.depth === 0 && c === "}" && this.objectStart >= 0) {
          try {
            const meal = JSON.parse(text.slice(this.objectStart, this.pos + 1));
            if (typeof meal?.name === "string") {
              this.meals.push({ name: meal.name, timeMinutes: Number(meal.timeMinutes) || 0 });
            }
          } catch {
            // Not valid on its own; skip it. The finished plan is what counts.
          }
          this.objectStart = -1;
        }
      }
    }
    return this.meals.length - before;
  }
}
