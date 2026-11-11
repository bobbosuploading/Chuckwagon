/**
 * Stock-up tips: flags sale items that are worth buying extra of, because the price is
 * well below usual AND the item keeps (freezer, pantry, or a few weeks in the fridge).
 *
 * Plain rules, no AI, so the same deal always gets the same tip. Collectors save the
 * tip on each deal (deals/{id}.stockUp) and the meal planner adds it to list items.
 * Storage times follow USDA FoodKeeper guidance, rounded to what's easy to remember.
 */
import type { Category } from "./config";

export interface StockUp {
  /** "great" = 45%+ off or buy-one-get-one; "good" = a solid discount worth a few extra. */
  level: "good" | "great";
  /** Why it's a stock-up price, e.g. "48% off" or "Buy one, get one free". */
  reason: string;
  /** Where it keeps. */
  keep: "freezer" | "pantry" | "fridge";
  /** How much to buy, e.g. "Enough for 6 to 8 weeks". */
  howMuch: string;
  /** How to store it, one or two short sentences. */
  storage: string;
}

/** The deal fields the rules look at (works for Kroger, H-E-B, Walmart and Flipp ads). */
export interface StockUpInput {
  name: string;
  size?: string | null;
  category: Category;
  pctOff: number;
  promo?: string | null;
}

interface Rule {
  match: RegExp;
  /** Only for these categories (optional). */
  categories?: Category[];
  keep: StockUp["keep"];
  storage: string;
  /** Short keepers need a deeper discount and a smaller stock-up. */
  short?: boolean;
}

/** Categories where "never stock up" applies (frozen spinach or pizza is fine). */
const FRESH: Category[] = ["produce", "dairy", "meat", "seafood", "bakery", "pantry"];

const LONG = "Enough for 6 to 8 weeks, until the next sale";
const SHORT = "Enough for 2 to 3 weeks";

/** First match wins, so specific rules come before broad ones. */
const RULES: Rule[] = [
  // Household goods never spoil.
  { match: /./, categories: ["household"], keep: "pantry", storage: "Doesn't go bad. Store it dry and out of the way." },

  // Canned and shelf-stable.
  { match: /\b(canned|cans?|tuna|chicken breast in water|beans?|soup|broth|stock|pasta sauce|marinara|salsa|tomato sauce|diced tomatoes)\b/i, categories: ["pantry", "seafood", "meat"], keep: "pantry", storage: "Keeps 1 to 2 years unopened. Check the best-by date and use the oldest first." },
  { match: /\b(pasta|spaghetti|macaroni|noodles|rice|flour|sugar|oats|oatmeal|cereal|peanut butter|oil|coffee|honey|syrup|cornmeal|masa|lentils)\b/i, categories: ["pantry"], keep: "pantry", storage: "Keeps for months in a cool, dry cupboard. Close bags tightly or move them to jars." },

  // Never stock up: spoils fast or doesn't freeze well.
  { match: /\b(milk|yogurt|sour cream|cream cheese|cottage cheese|half & half|creamer|deli salad|salad kit|lettuce|spinach|greens|herbs|cilantro|avocado|banana|tomato|cucumber|mushroom|rotisserie|sushi|fresh pasta|dip)\b/i, categories: FRESH, keep: "fridge", storage: "" },
  // Snacks and treats are rarely real savings to hoard.
  { match: /\b(chips|cookies|candy|soda|crackers|snacks?|ice cream|fruit snacks|gushers|jerky|cake|donuts?|pie)\b/i, categories: FRESH, keep: "pantry", storage: "" },

  // Already frozen.
  { match: /./, categories: ["frozen"], keep: "freezer", storage: "Already frozen. Keeps for months; best within 6 to 8 months." },

  // Meat and seafood for the freezer.
  { match: /\b(ground|burger|patties)\b/i, categories: ["meat"], keep: "freezer", storage: "Freeze flat in zip bags in meal-size portions, pressing out the air. Best within 3 to 4 months. Thaw in the fridge overnight." },
  { match: /\b(bacon|sausage|hot dogs?|franks|ham|lunch ?meat|deli|kielbasa|chorizo|pepperoni)\b/i, categories: ["meat"], keep: "freezer", storage: "Freeze in the unopened pack. Best within 1 to 2 months." },
  { match: /\b(chicken|turkey|thighs|drumsticks|wings|breasts?|leg quarters)\b/i, categories: ["meat"], keep: "freezer", storage: "Split into meal-size zip bags and freeze. Best within 9 months (a whole bird keeps a year)." },
  { match: /\b(steak|roast|chuck|brisket|ribs|chops?|loin|tenderloin|pork|beef|lamb|fajita)\b/i, categories: ["meat"], keep: "freezer", storage: "Wrap tightly (or leave in the sealed pack) and freeze. Best within 4 to 6 months." },
  { match: /./, categories: ["meat"], keep: "freezer", storage: "Freeze in meal-size portions. Best within 3 months." },
  { match: /\b(smoked|imitation|crab)\b/i, categories: ["seafood"], keep: "freezer", storage: "Freeze in the sealed pack. Best within 2 months." },
  { match: /./, categories: ["seafood"], keep: "freezer", storage: "Freeze in the store pack or a zip bag with the air pressed out. Best within 3 months." },

  // Dairy that freezes or keeps.
  { match: /\bbutter\b/i, categories: ["dairy"], keep: "freezer", storage: "Freeze in its box. Keeps 6 to 9 months." },
  { match: /\b(shredded|block|cheddar|mozzarella|monterey|colby|parmesan|swiss|pepper jack)\b/i, categories: ["dairy"], keep: "freezer", storage: "Freeze shredded or block cheese up to 6 months. It gets crumbly, so use it for cooking." },
  { match: /\beggs?\b/i, categories: ["dairy"], keep: "fridge", short: true, storage: "Keep in the carton in the back of the fridge, 3 to 5 weeks." },

  // Bread freezes well.
  { match: /\b(bread|tortillas?|buns|rolls|bagels|english muffins|pita|naan)\b/i, categories: ["bakery", "pantry"], keep: "freezer", storage: "Freeze in the bag. Best within 3 months; toast or warm straight from frozen." },

  // A few produce items keep or freeze.
  { match: /\b(potato(es)?|sweet potato(es)?|onions?)\b/i, categories: ["produce"], keep: "pantry", short: true, storage: "Keep in a cool, dark, airy spot (not the fridge), with potatoes and onions apart. Lasts 2 to 4 weeks." },
  { match: /\b(berries|blueberries|strawberries|raspberries|blackberries)\b/i, categories: ["produce"], keep: "freezer", storage: "Rinse, dry, freeze on a tray, then bag. Good for smoothies, oatmeal and baking for 8 to 12 months." },
  { match: /\b(apples?|carrots?|cabbage|lemons?|limes?|oranges?)\b/i, categories: ["produce"], keep: "fridge", short: true, storage: "Keeps 3 to 5 weeks in the fridge crisper drawer." },
];

/** Reads ad promos like "Buy 1 get 1 free" into an effective percent off. */
export function promoPctOff(promo?: string | null): { pct: number; reason: string } | null {
  if (!promo) return null;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4 };
  const num = (s: string) => words[s.toLowerCase()] ?? Number(s);
  if (/\b(bogo|buy one,? get one free)\b/i.test(promo)) return { pct: 50, reason: "Buy one, get one free" };
  const m = promo.match(/buy\s+(\d+|one|two|three|four),?\s+get\s+(\d+|one|two)\s+(\S+\s+)?free/i);
  if (m) {
    const buy = num(m[1]);
    const free = num(m[2]);
    // Only same-item offers count; "buy 2, get pasta free" isn't a stock-up price on this item.
    if (buy > 0 && free > 0 && (!m[3] || /^(more|of|same)\b/i.test(m[3]))) {
      return { pct: Math.round((free / (buy + free)) * 100), reason: `Buy ${buy}, get ${free} free` };
    }
  }
  return null;
}

/** How an item keeps (freezer, pantry, fridge) and how to store it, whatever its price. */
export function keepRule(name: string, category: Category): { keep: StockUp["keep"]; storage: string } | null {
  const rule = RULES.find((r) => (!r.categories || r.categories.includes(category)) && r.match.test(name));
  return rule ? { keep: rule.keep, storage: rule.storage } : null;
}

const GOOD_PCT = 30;
const GREAT_PCT = 45;
const SHORT_PCT = 40;

/** A stock-up tip for this deal, or null if it isn't a stock-up price or doesn't keep. */
export function stockUpTip(d: StockUpInput): StockUp | null {
  const text = `${d.name} ${d.size ?? ""}`;
  const rule = RULES.find((r) => (!r.categories || r.categories.includes(d.category)) && r.match.test(text));
  if (!rule || !rule.storage) return null;

  const fromPromo = promoPctOff(d.promo);
  const pct = Math.max(d.pctOff ?? 0, fromPromo?.pct ?? 0);
  if (pct < (rule.short ? SHORT_PCT : GOOD_PCT)) return null;

  const reason = fromPromo && fromPromo.pct >= (d.pctOff ?? 0) ? fromPromo.reason : `${pct}% off`;
  return {
    level: pct >= GREAT_PCT ? "great" : "good",
    reason,
    keep: rule.keep,
    howMuch: rule.short ? SHORT : LONG,
    storage: rule.storage,
  };
}

/** Adds `stockUp` to a deal before it's saved (null when it isn't a stock-up item). */
export function withStockUp<T extends StockUpInput>(d: T): T & { stockUp: StockUp | null } {
  return { ...d, stockUp: stockUpTip(d) };
}
