import SwiftUI
import FirebaseCore

@main
struct ChuckwagonApp: App {
    @State private var prefs = Preferences()

    init() {
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
