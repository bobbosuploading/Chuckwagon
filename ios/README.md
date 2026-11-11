# Chuckwagon for iPhone

SwiftUI app (iOS 17+). The Xcode project is generated from `project.yml` with XcodeGen, so it is not checked in.

## First-time setup (on the Mac)

1. `brew install xcodegen`
2. Bundle ID is `com.bobby.chuckwagon` (set in `project.yml`).
3. Firebase console > Project settings > Add app > iOS, using the same bundle ID.
   Download `GoogleService-Info.plist` into `ios/Chuckwagon/` (it is gitignored).
4. Firebase console > Authentication > Sign-in method > turn on **Anonymous**.
5. `cd ios && xcodegen && open Chuckwagon.xcodeproj`. To try it on your iPhone, use the dev app below.

The "Plan my meals" button needs the `planMealsForStore` function deployed (see the main README).

## Share extension ("Share a deal")

The **Chuckwagon** target embeds a share extension, **ChuckwagonShare** (`com.bobby.chuckwagon.share`),
so shoppers can share a Facebook, TikTok or Reddit post, a web page or a screenshot to Chuckwagon.
The extension only saves what was shared into the App Group `group.com.bobby.chuckwagon`; the app
picks it up when it opens and finishes in the Share a deal screen (`Shared/ShareInbox.swift`).

First archive after this was added (Mac, once):

1. `cd ios && xcodegen && open Chuckwagon.xcodeproj`
2. Target **ChuckwagonShare** > Signing & Capabilities > Team = your team (same as the app).
3. On both **Chuckwagon** and **ChuckwagonShare**, check that App Groups shows `group.com.bobby.chuckwagon`
   with a check mark. With automatic signing Xcode registers the group and the extension's App ID itself;
   if it shows a red error, click "Try Again" or add the group in the developer website under
   Identifiers > App Groups.
4. Archive as usual. The extension ships inside the app; nothing extra to upload.

The dev app has no share extension. Use the "Share a deal" button on its home screen instead.

## Dev app (test on your iPhone without touching TestFlight)

There are two app targets built from the same code:

| Scheme | Bundle ID | Name on the phone | Use it for |
| --- | --- | --- | --- |
| **Chuckwagon** | `com.bobby.chuckwagon` | Chuckwagon | Archive and upload to TestFlight / App Store |
| **ChuckwagonDev** | `com.bobby.chuckwagon.dev` | Chuckwagon Dev (red DEV icon) | Run from Xcode straight onto your iPhone |

Because the bundle IDs differ, the dev app installs **next to** the TestFlight app and never replaces it.
It talks to the same Firebase project, so it sees the same deals and backend. It signs in as its own
anonymous user, so its saved plans and settings are separate from the TestFlight app's.

Do **not** run the plain **Chuckwagon** scheme onto your phone: that has the TestFlight bundle ID and would
replace the TestFlight app (reinstall it from the TestFlight app if that happens; nothing on the server is lost).

### One-time setup (Mac)

1. Firebase console > Project settings > General > **Add app** > iOS. Bundle ID `com.bobby.chuckwagon.dev`,
   nickname "Chuckwagon Dev". Skip the SDK steps.
2. Download its `GoogleService-Info.plist` into `ios/Dev/` (not `ios/Chuckwagon/`). It is gitignored.
3. When App Check is on: App Check > Apps > Chuckwagon Dev > App Attest > Save too, or the dev app's calls
   will be rejected once enforcement is turned on.

### Each time

1. `cd ios && xcodegen && open Chuckwagon.xcodeproj`
2. Plug in the iPhone (or use it over Wi-Fi), pick the **ChuckwagonDev** scheme and your iPhone at the top of Xcode.
3. First time only: target **ChuckwagonDev** > Signing & Capabilities > Team = your team. Xcode creates the
   dev App ID and profile for you.
4. Press Run (⌘R). On the phone, the first time: Settings > Privacy & Security > Developer Mode > On (the phone restarts).

Swift code can check `#if DEV_BUILD` for dev-only behaviour.
