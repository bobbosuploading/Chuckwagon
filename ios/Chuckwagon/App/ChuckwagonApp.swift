import SwiftUI
import FirebaseCore
import FirebaseAppCheck

@main
struct ChuckwagonApp: App {
    @State private var prefs = Preferences()

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
                .tint(Theme.red)
                .preferredColorScheme(.light)
        }
    }
}

struct RootView: View {
    @Environment(Preferences.self) private var prefs
    @State private var signInError: String?

    var body: some View {
        // Everyone lands on the stores near them. A new shopper sets their area right there.
        StoresHomeView()
        .task {
            do { try await Backend.signIn() } catch { signInError = error.localizedDescription }
        }
        .alert("Couldn't connect", isPresented: Binding(get: { signInError != nil }, set: { if !$0 { signInError = nil } })) {
            Button("OK") { signInError = nil }
        } message: {
            Text(signInError ?? "")
        }
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
