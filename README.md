# Chuckwagon

Turns this week's grocery sales into meals and a shopping list.

This repo holds the Firebase backend. Phase 1 collects Kroger sale items for stores near a home ZIP code every Monday, Wednesday and Friday and stores them in Firestore. H-E-B, meal planning and the iOS app come next.

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
4. Create `functions/.env` from `functions/.env.example` and fill in your Kroger client ID.
5. Store the Kroger client secret in Secret Manager (never in the code):
   `firebase functions:secrets:set KROGER_CLIENT_SECRET`

## Deploy

```
cd functions && npm install && cd ..
firebase deploy --only functions,firestore
```

## Run it now instead of waiting for Monday

Google Cloud console > Cloud Scheduler > the `collectKroger` job > **Force run**. Then check Firestore for `deals`, and `firebase functions:log` for the summary.

## Changing what's collected

Edit `functions/src/config.ts`: search terms per category, number of stores, search radius.
