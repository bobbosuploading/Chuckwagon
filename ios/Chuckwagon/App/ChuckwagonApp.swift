import SwiftUI
import FirebaseCore
import FirebaseAppCheck

@main
struct ChuckwagonApp: App {
    @State private var prefs = Preferences()
    @State private var mealRatings = MealRatings()
    @State private var householdList = HouseholdList()

    init() {
        // App Check proves calls come from the real Chuckwagon app, so nobody can
        // use the backend (and its AI credits) from a script. Must run before configure().
        AppCheck.setAppCheckProviderFactory(ChuckwagonAppCheckFactory())
        FirebaseApp.configure()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(prefs)
                .environment(mealRatings)
                .environment(householdList)
                .tint(Theme.red)
                .preferredColorScheme(.light)
        }
    }
}

struct RootView: View {
    @Environment(Preferences.self) private var prefs
    @Environment(MealRatings.self) private var mealRatings
    @Environment(HouseholdList.self) private var householdList
    @State private var signInError: String?
    /// A shared meal or plan opened from a link.
    @State private var openedShare: OpenedShare?

    /// An invite to a household's shared shopping list, opened from a link.
    @State private var openedInvite: OpenedShare?

    struct OpenedShare: Identifiable { let id: String }

    var body: some View {
        // Everyone lands on the stores near them. A new shopper sets their area right there.
        StoresHomeView()
        .task {
            do { try await Backend.signIn() } catch { signInError = error.localizedDescription }
            householdList.start()
            await mealRatings.load()
        }
        // Shared meal links: https://chuckwagon-ebbcc.web.app/m/{id} (universal link) or chuckwagon://m/{id}.
        .onOpenURL { openShared($0) }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
            if let url = activity.webpageURL { openShared(url) }
        }
        .sheet(item: $openedShare) { SharedMealsView(id: $0.id) }
        .sheet(item: $openedInvite) { JoinHouseholdView(code: $0.id) }
        .alert("Couldn't connect", isPresented: Binding(get: { signInError != nil }, set: { if !$0 { signInError = nil } })) {
            Button("OK") { signInError = nil }
        } message: {
            Text(signInError ?? "")
        }
    }
}

extension RootView {
    private func openShared(_ url: URL) {
        // Household invites: https://chuckwagon-ebbcc.web.app/h/{code} or chuckwagon://h/{code}.
        if let code = ShareLinks.inviteCode(from: url) {
            if openedInvite?.id != code { openedInvite = OpenedShare(id: code) }
            return
        }
        guard let id = ShareLinks.sharedId(from: url), openedShare?.id != id else { return }
        openedShare = OpenedShare(id: id)
    }
}

/// Real iPhones use Apple's App Attest. The simulator can't, so it uses the debug provider:
/// its token prints in the Xcode console and must be added under App Check > Manage debug tokens.
final class ChuckwagonAppCheckFactory: NSObject, AppCheckProviderFactory {
    func createProvider(with app: FirebaseApp) -> AppCheckProvider? {
        #if targetEnvironment(simulator)
        return AppCheckDebugProvider(app: app)
        #else
        return AppAttestProvider(app: app)
        #endif
    }
}
