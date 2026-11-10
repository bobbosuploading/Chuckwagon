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

/**
 * Price regions (see regions.ts). Stores of the same chain and Kroger division within
 * KROGER_SHARE_MILES of a collected store reuse its deals and prices instead of being
 * collected again. At most KROGER_MAX_SOURCE_STORES stores are collected in full per run
 * (about 130 product calls each; Kroger allows 10,000 a day). Past the cap, a store borrows
 * from the nearest collected store of its chain within KROGER_STRETCH_MILES.
 */
export const KROGER_SHARE_MILES = 50;
export const KROGER_MAX_SOURCE_STORES = 8;
export const KROGER_STRETCH_MILES = 120;

/** Weekly ads (H-E-B, ALDI, Dollar General): at most this many different flyers loaded per chain per run. */
export const AD_MAX_REGIONS = 6;
/** Results per search page (Kroger max 50) and pages per term. */
export const PAGE_SIZE = 50;
export const PAGES_PER_TERM = 2;

/**
 * Walmart has no weekly ad. We watch the best-selling items for each search term above,
 * record their price (for the home ZIP) every run, and call it a deal when the price is
 * a Rollback/Clearance, shows a crossed-out "was" price, or drops below its usual price.
 */
export const WALMART_ITEMS_PER_TERM = 5;
/** Upper bound on items priced per run (lookups are 20 items per call). */
export const WALMART_MAX_ITEMS = 300;
/** Walmart taxonomy IDs to search within. If a search finds nothing there, it retries without one. */
export const WALMART_CATEGORY_IDS: Partial<Record<Category, string>> & { default: string } = {
  default: "976759", // Food
  household: "1115193", // Household Essentials
};
/** A price must be at least this far below the usual price to count as a deal. */
export const WALMART_MIN_DROP = 0.08;
