import SwiftUI
import UIKit

/// Keeps the iPhone from locking while the shopping list or a recipe is open, so a shopper
/// with full hands doesn't have to unlock it again. How long is the shopper's choice
/// (Settings > Shopping and cooking): off, 30 or 60 minutes, or as long as the screen is open.
/// Normal auto-lock comes back when they leave those screens or the time runs out.
@MainActor
enum ScreenAwake {
    /// The choices, in minutes. -1 means as long as the screen is open.
    static let choices: [(minutes: Int, label: String)] = [(0, "Off"), (30, "30 minutes"), (60, "1 hour"), (-1, "While it's open")]
    static let defaultMinutes = 30

    private static var holders = 0
    private static var offTask: Task<Void, Never>?

    fileprivate static func begin(minutes: Int) {
        holders += 1
        UIApplication.shared.isIdleTimerDisabled = true
        offTask?.cancel()
        offTask = nil
        guard minutes > 0 else { return }
        // Each newly opened screen starts the clock again.
        offTask = Task {
            try? await Task.sleep(for: .seconds(minutes * 60))
            guard !Task.isCancelled else { return }
            UIApplication.shared.isIdleTimerDisabled = false
        }
    }

    fileprivate static func end() {
        holders = max(0, holders - 1)
        guard holders == 0 else { return }
        offTask?.cancel()
        offTask = nil
        UIApplication.shared.isIdleTimerDisabled = false
    }
}

private struct KeepScreenAwake: ViewModifier {
    @Environment(Preferences.self) private var prefs
    @State private var holding = false

    func body(content: Content) -> some View {
        content
            .onAppear { start() }
            .onDisappear { stop() }
            .onChange(of: prefs.keepScreenOnMinutes) { _, _ in
                stop()
                start()
            }
    }

    private func start() {
        guard !holding, prefs.keepScreenOnMinutes != 0 else { return }
        holding = true
        ScreenAwake.begin(minutes: prefs.keepScreenOnMinutes)
    }

    private func stop() {
        guard holding else { return }
        holding = false
        ScreenAwake.end()
    }
}

/// A "Done" button above the keyboard that puts it away, for screens with text fields.
private struct KeyboardDoneButton: ViewModifier {
    func body(content: Content) -> some View {
        content.toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { hideKeyboard() }
                    .font(Theme.body(.body, weight: .semibold))
            }
        }
    }
}

/// Puts the keyboard away, whichever field has it.
@MainActor
func hideKeyboard() {
    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
}

extension View {
    /// Keeps the screen from locking while this view is showing (see ScreenAwake).
    func keepsScreenAwake() -> some View { modifier(KeepScreenAwake()) }

    /// Adds a Done button above the keyboard.
    func keyboardDoneButton() -> some View { modifier(KeyboardDoneButton()) }
}
