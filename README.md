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

H-E-B has no API. For the beta, `.github/workflows/collect-heb-prices.yml` runs once a month (the 2nd)
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
