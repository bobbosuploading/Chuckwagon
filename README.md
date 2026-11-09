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

`planMealsForStore` (callable Cloud Function) takes a store and the shopper's preferences, picks the best current deals at that store, asks Claude for meals and a grocery list (structured JSON), prices the list from Firestore, and saves it to `plans/`. The model is set by `DEFAULT_MODEL` in `functions/src/plan.ts`.

Secrets: `firebase functions:secrets:set ANTHROPIC_API_KEY` (for the function) and an `ANTHROPIC_API_KEY` GitHub secret (for testing).

Try it without the app: GitHub > Actions > **Test meal plan** > Run workflow, pick a model and preferences. The plan shows on the run's summary page and is saved in Firestore `plans/`.
