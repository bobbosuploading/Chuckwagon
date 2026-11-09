import { initializeApp } from "firebase-admin/app";

initializeApp();

// Cloud Functions for Chuckwagon go here (the meal planner comes next).
//
// Deal collection does NOT run here: Kroger's bot protection blocks requests
// from Google Cloud. It runs from GitHub Actions instead
// (.github/workflows/collect-kroger.yml -> functions/src/cli.ts).
