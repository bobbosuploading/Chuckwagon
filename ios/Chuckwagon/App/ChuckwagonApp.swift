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
                .tint(.chuckRed)
        }
    }
}

struct RootView: View {
    @Environment(Preferences.self) private var prefs
    @State private var signInError: String?

    var body: some View {
        Group {
            if prefs.hasOnboarded {
                HomeView()
            } else {
                OnboardingView()
            }
        }
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

extension Color {
    /// Chuckwagon brand red.
    static let chuckRed = Color(red: 0.70, green: 0.23, blue: 0.17)
}
