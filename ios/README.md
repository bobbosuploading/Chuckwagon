# Chuckwagon for iPhone

SwiftUI app (iOS 17+). The Xcode project is generated from `project.yml` with XcodeGen, so it is not checked in.

## First-time setup (on the Mac)

1. `brew install xcodegen`
2. In `project.yml`, replace `com.example` with your bundle ID prefix (both places).
3. Firebase console > Project settings > Add app > iOS, using the same bundle ID.
   Download `GoogleService-Info.plist` into `ios/Chuckwagon/` (it is gitignored).
4. Firebase console > Authentication > Sign-in method > turn on **Anonymous**.
5. `cd ios && xcodegen && open Chuckwagon.xcodeproj`, pick an iPhone simulator, and run.

The "Plan my meals" button needs the `planMealsForStore` function deployed (see the main README).
