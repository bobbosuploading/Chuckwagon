# Chuckwagon for iPhone

SwiftUI app (iOS 17+). The Xcode project is generated from `project.yml` with XcodeGen, so it is not checked in.

## First-time setup (on the Mac)

1. `brew install xcodegen`
2. Bundle ID is `com.bobby.chuckwagon` (set in `project.yml`).
3. Firebase console > Project settings > Add app > iOS, using the same bundle ID.
   Download `GoogleService-Info.plist` into `ios/Chuckwagon/` (it is gitignored).
4. Firebase console > Authentication > Sign-in method > turn on **Anonymous**.
5. `cd ios && xcodegen && open Chuckwagon.xcodeproj`, pick an iPhone simulator, and run.

The "Plan my meals" button needs the `planMealsForStore` function deployed (see the main README).

## App Check

The app sends an App Check token with every Firebase call, so only the real Chuckwagon app can use the backend.
Real iPhones (Xcode, TestFlight, App Store) use Apple's **App Attest**. The simulator uses the debug provider:
its token prints in the Xcode console, and you add it under Firebase console > App Check > Apps > ⋮ > Manage debug tokens.

Rollout, in order:

1. Firebase console > App Check > Apps > the iOS app > **App Attest** > Save (needs the Apple Team ID).
2. Ship a TestFlight build with App Check. Until the next step, older builds keep working.
3. When App Check > APIs shows mostly verified requests, turn enforcement on:
   - Functions: set the GitHub repo variable `APP_CHECK_ENFORCE` to `true` and run the "Deploy to Firebase" workflow.
   - Firestore: App Check > APIs > Cloud Firestore > **Enforce**.

To undo, set `APP_CHECK_ENFORCE` back to `false` and redeploy, and click Unenforce for Firestore.
