# Chuckwagon

Turns this week's grocery sales into meals and a shopping list.

This repo holds the Firebase backend. Phase 1 collects Kroger sale items for stores near a home ZIP code every Monday, Wednesday and Friday (via GitHub Actions) and stores them in Firestore. H-E-B, meal planning and the iOS app come next.

## Data

| Collection | Doc ID | What it holds |
|---|---|---|
| `stores` | `kroger-{locationId}` | Store name, chain, address |
| `deals` | `{storeId}_{productId}` | Name, brand, size, category, regular price, sale price, savings, % off, image |
| `runs` | auto | One log entry per collection run (counts and errors) |

Deals that were not seen in the latest run are deleted, so `deals` always holds current sales only.

## One-time setup

1. Install Node.js 22 (LTS) and the Firebase CLI: `npm install -g firebase-tools`, then `firebase login`.
2. In the Firebase console, create the `chuckwagon` project, enable Firestore, and switch to the Blaze plan (set a budget alert).
3. Clone this repo, then link it to your project: `firebase use --add` and pick the project.
4. Add the GitHub Actions secrets listed below.

## Deploy

```
cd functions && npm install && cd ..
firebase deploy --only firestore
```

## Run it now instead of waiting for Monday

GitHub > Actions > **Collect Kroger deals** > **Run workflow**. Then check Firestore for `deals` and the latest entry in `runs`.

## Changing what's collected

Edit `functions/src/config.ts`: search terms per category, number of stores, search radius.

## Running the collector outside Google Cloud

Kroger's bot protection blocks requests from Google Cloud, so the scheduled Cloud Function can't reach the store lookup. The same code can run from GitHub Actions (`.github/workflows/collect-kroger.yml`) or any computer with `node functions/lib/cli.js`.

GitHub Actions needs three repository secrets (Settings > Secrets and variables > Actions):

| Secret | Value |
|---|---|
| `KROGER_CLIENT_ID` | Kroger app client ID |
| `KROGER_CLIENT_SECRET` | Kroger app client secret |
| `FIREBASE_SERVICE_ACCOUNT` | Full JSON of a Firebase service account key (Firebase console > Project settings > Service accounts > Generate new private key) |

Run it on demand from the Actions tab > Collect Kroger deals > Run workflow.

## Meal planner (phase 2)

`planMealsForStore` (callable Cloud Function) takes a store and the shopper's preferences, picks the best current deals at that store, asks Claude for meals and a grocery list (structured JSON), prices the list from Firestore, and saves it to `plans/`. Everyday plans use Claude Haiku 5.5 (`DEFAULT_MODEL`); premium plans (`premium: true`) use Claude Opus 5.5 (`PREMIUM_MODEL`), both in `functions/src/plan.ts`.

Secrets: `firebase functions:secrets:set ANTHROPIC_API_KEY` (for the function) and an `ANTHROPIC_API_KEY` GitHub secret (for testing).

Try it without the app: GitHub > Actions > **Test meal plan** > Run workflow, pick a model and preferences. The plan shows on the run's summary page and is saved in Firestore `plans/`.

## Walmart

Walmart has no weekly ad, so `.github/workflows/collect-walmart.yml` (Mon/Wed/Fri) prices the
best-selling items for each search term in `functions/src/config.ts` (about 200 to 300 items)
for the home ZIP through the Walmart Affiliate API. Each item's price history is kept in
`walmartPrices/{zip}_{itemId}`. An item is saved to `deals` when Walmart marks it Rollback, Clearance
or Special Buy, shows a crossed-out price, or costs at least 8% less than its usual price over
the last 60 days (needs 3 earlier runs, so price drops start showing about a week in).
Prices are walmart.com prices for the ZIP; they usually match the shelf.

The workflow skips itself until these repository secrets exist:

| Secret | Value |
|---|---|
| `WALMART_CONSUMER_ID` | Consumer ID from walmart.io after uploading your public key |
| `WALMART_PRIVATE_KEY` | Full text of the matching private key (`WM_IO_private_key.pem`) |
| `WALMART_KEY_VERSION` | Key version shown on walmart.io (usually `1`) |
| `WALMART_PUBLISHER_ID` | Optional: your Impact publisher ID, for affiliate links |

Try it first with **Actions > Collect Walmart prices > Run workflow** (dry run is on by default).

## H-E-B everyday prices (beta only)

H-E-B has no API. For the beta, `.github/workflows/collect-heb-prices.yml` runs once a month (the 11th, the day after the Apify free plan resets)
and fetches shelf prices for about 80 staple ingredients (711 products) at the H-E-B nearest the home
ZIP through a third-party Apify scraper (`zaiq/heb-scraper`, about $0.006 per product). That fits
Apify's free plan ($5 of usage a month), and each run is capped so it can't cost more. Prices are
merged into `priceBooks/heb-{zip}` and kept for 120 days; meal plans use them for items that aren't
on sale, and fall back to a Kroger estimate for anything H-E-B's list doesn't have.

This scrapes heb.com, which H-E-B's terms don't allow. Use it for TestFlight only and turn it off
before a paid launch: set the repository variable `HEB_PRICES_ENABLED` to `false`
(Settings > Secrets and variables > Actions > Variables).

Setup: make a free account at apify.com, copy your API token (Settings > API & Integrations), and
save it as the repository secret `APIFY_TOKEN`. Then try **Actions > Collect H-E-B everyday prices >
Run workflow** (dry run, 20 products, about 14 cents).

## More areas: price regions

Shoppers add their ZIP in the app (`registerArea`, at most 15 areas during the beta; later ones are waitlisted).
The Kroger, H-E-B ad and ALDI/Dollar General ad collectors then cover the home ZIP plus every registered area,
without collecting the same prices twice (`functions/src/regions.ts`):

- **Kroger:** the stores near each area are grouped by chain and Kroger division. One store per group (within
  `KROGER_SHARE_MILES`, 50 mi) is collected in full; the others get `dealsFrom` / `everydayFrom` pointing at it.
  At most `KROGER_MAX_SOURCE_STORES` (8) stores are collected per run, about 1,100 of Kroger's 10,000 free daily
  product calls. Settings are in `functions/src/config.ts`.
- **H-E-B, ALDI, Dollar General ads:** Flipp hands every ZIP in a chain's ad region the same flyer, so each flyer is
  read once and the other areas point at it. At most `AD_MAX_REGIONS` (6) different flyers per chain per run.
- **H-E-B everyday prices** still come from the one monthly Apify run for the home ZIP (no extra Apify cost);
  every other H-E-B area uses them.
- **Walmart** still covers the home ZIP only.

Every store that borrows has a `pricesNote` (e.g. "Prices from Kroger, Sugar Land (14 mi away)") that the app shows
under the store and on meal plans, and everyday prices taken from the sharing store show as "nearby price".
An area moves from `pending` to `ready` after the first collector run that covers it.

To try other areas without touching the real list, run a collector from the Actions tab with **dry run** on and
`area_zips` set, e.g. `78701,75201`.

## Send to cart

On a meal plan's grocery list, **Send to cart** has one button per store (items already checked off are left out):

- **Kroger family stores:** "Add to my Kroger cart". The shopper signs in with Kroger once. The backend swaps the sign-in code for tokens (`krogerCallback`) and keeps them in `krogerTokens/{uid}` (backend-only). The phone gets a short-lived token (`krogerAccessToken`) and itself searches products and calls Kroger's cart API, because Kroger blocks product and cart calls from Google Cloud. Sale items use their exact product; other items use the first match at that store. Items go in for pickup.
- **Walmart:** "Add to my Walmart cart" opens Walmart's add-to-cart link (`affil.walmart.com/cart/addToCart?items=ID|QTY,...`) with the plan's Walmart sale items. Items that aren't on sale have no Walmart item id yet, so the app lists them for the shopper to add by hand. Runs on the phone only; no backend setup.
- **H-E-B and every other store:** "Share list" for now: the iOS share sheet with that store's list grouped by aisle (to Reminders, Notes, Messages...). Instacart isn't taking new developers yet. Once it is, set `SendToCart.instacartEnabled = true` in the app and the button becomes "Shop on Instacart". `instacartShoppingList` makes an Instacart shopping list page for that store's items and the app opens it; the shopper picks H-E-B (or another store) in Instacart.

Setup (all optional; without them the buttons just say the feature isn't set up):

| Where | Name | Value |
|---|---|---|
| Kroger developer portal > your app | Redirect URI | `https://us-central1-chuckwagon-ebbcc.cloudfunctions.net/krogerCallback` (the app must also have the Cart API) |
| GitHub secret | `KROGER_CLIENT_ID`, `KROGER_CLIENT_SECRET` | Already set for the collector |
| GitHub secret | `INSTACART_API_KEY` | Instacart Developer Platform API key |
| GitHub variable (optional) | `INSTACART_API_URL` | `https://connect.dev.instacart.tools` while using a development key; leave unset for production |

The **Deploy to Firebase** workflow writes these into `functions/.env` before deploying. When deploying from a Mac, create `functions/.env` with the same names.

## What's new list (TestFlight)

`CHANGES.txt` lists what's new in each TestFlight build, newest first, in plain text ready to paste into TestFlight's "What to Test" box. Each time the build number in `ios/project.yml` goes up, add a `Build N` section at the top. The **Build iPhone app** workflow fails if the current build number has no section.

## Sam's Club stock-up list (beta only)

Sam's Club has no price feed. `.github/workflows/collect-sams.yml` runs once a month (the 12th)
through an Apify scraper of samsclub.com search pages: about 320 bulk staples for about 30 cents,
capped at 45 cents, which fits beside the H-E-B run in Apify's free $5. `functions/src/clubPrices.ts`
works out each item's price per lb (or each, or per fl oz), asks Haiku which H-E-B / Kroger products
are the same food, and saves the comparison to `clubLists/sams` for the app's "Stock-up trip" screen.
Only items with a grocery price to compare are kept; an item is "worth the trip" at 10% cheaper or more.

These are website prices, the same for every club. Manual runs default to a 20-item dry run.
`REUSE_LAST=1` redoes the comparison on the last run's rows without scraping again.
Like the H-E-B scraper, turn it off before a paid launch: set the repository variable
`SAMS_PRICES_ENABLED` to `false`.

### Staying inside Apify's free $5

The H-E-B run (about $4.30) and the Sam's Club run (about 30 cents) together nearly fill the month.
GitHub can start a scheduled run hours late, so a run by hand plus the late scheduled one once ran
H-E-B twice in a day and used the whole allowance. Both jobs now check the `runs` log and skip when
that job already saved prices in the last 25 days (`functions/src/apifyBudget.ts`). The "force" input
on a manual run overrides this. Test runs still cost money, so keep them small.
