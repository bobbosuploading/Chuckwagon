import SwiftUI

/// Meals the shopper marked "Don't suggest again". Saved on their account (users/{uid}.dislikedMeals,
/// written only by the backend) so new plans skip them. Shared app-wide through the environment.
@MainActor
@Observable
final class DislikedMeals {
    /// The backend keeps only this many (MAX_DISLIKED_MEALS in functions/src/dislikedMeals.ts).
    static let maxCount = 30
    private(set) var names: [String] = []
    private(set) var loaded = false
    /// The meal being saved right now, so its button can show a spinner.
    private(set) var saving: String?

    func contains(_ name: String) -> Bool {
        let key = name.lowercased()
        return names.contains { $0.lowercased() == key }
    }

    /// Reads the list once (or again with force), after sign-in.
    func load(force: Bool = false) async {
        guard force || !loaded else { return }
        if let list = try? await Backend.dislikedMeals() {
            names = list
            loaded = true
        }
    }

    /// Marks a meal as disliked, or takes it off the list. Returns nil when it saved, or a message to show.
    @discardableResult
    func set(_ name: String, disliked: Bool) async -> String? {
        guard saving == nil else { return "Still saving the last change. Try again in a moment." }
        saving = name
        defer { saving = nil }
        do {
            names = try await Backend.setMealDisliked(name: name, disliked: disliked)
            loaded = true
            return nil
        } catch {
            return Backend.friendlyMessage(for: error)
        }
    }
}
