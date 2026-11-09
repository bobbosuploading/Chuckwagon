/**
 * What to collect. Edit these lists to change coverage; no other code needs to change.
 *
 * Kroger's API has no "weekly ad" endpoint, so we search common grocery terms at
 * each store and keep only items whose promo price is below the regular price.
 */

export type Category =
  | "meat"
  | "seafood"
  | "produce"
  | "dairy"
  | "bakery"
  | "pantry"
  | "frozen"
  | "household";

export const SEARCH_TERMS: Record<Category, string[]> = {
  meat: ["chicken", "ground beef", "steak", "pork", "bacon", "sausage", "turkey", "ham"],
  seafood: ["shrimp", "salmon", "fish"],
  produce: ["fresh vegetables", "fresh fruit", "potatoes", "onions", "peppers", "tomatoes", "lettuce", "apples", "berries"],
  dairy: ["milk", "cheese", "eggs", "yogurt", "butter"],
  bakery: ["bread", "tortillas"],
  pantry: ["pasta", "rice", "beans", "canned vegetables", "cereal", "soup", "pasta sauce", "flour"],
  frozen: ["frozen vegetables", "frozen meals", "frozen pizza"],
  household: ["paper towels", "toilet paper", "laundry detergent", "dish soap", "trash bags"],
};

/** Kroger family stores to include, nearest first. */
export const KROGER_STORE_LIMIT = 3;
/** Search radius from the home ZIP, in miles (Kroger API max is 100). */
export const KROGER_RADIUS_MILES = 50;
/** Results per search page (Kroger max 50) and pages per term. */
export const PAGE_SIZE = 50;
export const PAGES_PER_TERM = 2;
