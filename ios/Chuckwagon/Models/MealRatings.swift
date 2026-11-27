import SwiftUI

/// The words and icons for liking and disliking meals, in one place so they're easy to change.
/// A nod to the old chuckwagon: a meal worth cooking again is a "Keeper" (a sheriff's star),
/// and one you're done with gets "fed to the dogs". Screen readers hear plain Like / Don't like.
enum MealRatingWords {
    static let like = "Keeper"
    static let likeIcon = "star.fill"
    static let likeUndo = "Not a keeper"
    static let likeUndoIcon = "star.slash"
    static let likedList = "Keepers"
    static let likedBadge = "Keeper"
    static let likeHint = "Keepers show up first when you pick saved meals for a new plan."

    static let dislike = "Feed it to the dogs"
    static let dislikeIcon = "dog"
    static let dislikeUndo = "Bring it back"
    static let dislikeUndoIcon = "arrow.uturn.backward"
    static let dislikedList = "Fed to the dogs"
    static let dislikedBadge = "Fed to the dogs. New plans skip it."
    static let dislikeHint = "New plans stop suggesting this meal and ones like it."

    static let likeColor = Theme.mustard
    static let dislikeColor = Theme.red
}

/// The shopper's own note on a meal ("used twice the garlic"). Private to them, saved on their
/// account (users/{uid}.mealNotes, written only by the backend), and shown wherever the meal turns up.
struct MealNote: Hashable {
    var name: String
    var note: String

    static func list(from raw: Any?) -> [MealNote] {
        (raw as? [[String: Any]] ?? []).compactMap { item in
            guard let name = item["name"] as? String, let note = item["note"] as? String, !note.isEmpty else { return nil }
            return MealNote(name: name, note: note)
        }
    }
}

/// Meals the shopper rated: Keepers (liked, saved with their recipes so the saved-meal picker
/// can show them first) and meals fed to the dogs (disliked, so new plans skip them). Both live
/// on the shopper's account (users/{uid}.likedMeals and .dislikedMeals, written only by the
/// backend). A meal is never on both lists. Shared app-wide through the environment.
@MainActor
@Observable
final class MealRatings {
    /// The backend keeps only this many (MAX_DISLIKED_MEALS / MAX_LIKED_MEALS in functions/src).
    static let maxDisliked = 30
    static let maxLiked = 50
    /// Disliked meal names, oldest first.
    private(set) var disliked: [String] = []
    /// Keepers with their recipes, oldest first.
    private(set) var liked: [MealPlan.Meal] = []
    private(set) var loaded = false
    /// The meal being saved right now, so its button can show a spinner.
    private(set) var saving: String?
    /// The shopper's notes on meals, oldest first.
    private(set) var notes: [MealNote] = []
    /// The meal whose note is being saved right now.
    private(set) var savingNote: String?
    /// The backend keeps this many notes, each up to this long (MAX_MEAL_NOTES / MAX_NOTE_LENGTH).
    static let maxNotes = 100
    static let maxNoteLength = 500

    /// Names match loosely (case, spacing and punctuation don't count), since the backend
    /// cleans names before saving them.
    nonisolated static func key(_ name: String) -> String {
        String(name.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    func isDisliked(_ name: String) -> Bool {
        let k = Self.key(name)
        return disliked.contains { Self.key($0) == k }
    }

    func isLiked(_ name: String) -> Bool {
        let k = Self.key(name)
        return liked.contains { Self.key($0.name) == k }
    }

    /// The shopper's note on a meal, if they wrote one.
    func note(for name: String) -> String? {
        let k = Self.key(name)
        return notes.last { Self.key($0.name) == k }?.note
    }

    /// Saves a note on a meal (an empty note deletes it). Returns nil when it saved, or a message to show.
    @discardableResult
    func setNote(_ name: String, _ note: String) async -> String? {
        guard savingNote == nil else { return "Still saving the last note. Try again in a moment." }
        savingNote = name
        defer { savingNote = nil }
        do {
            notes = try await Backend.saveMealNote(name: name, note: note.trimmingCharacters(in: .whitespacesAndNewlines))
            return nil
        } catch {
            return Backend.friendlyMessage(for: error)
        }
    }

    /// Reads both lists and the notes once (or again with force), after sign-in.
    func load(force: Bool = false) async {
        guard force || !loaded else { return }
        if let ratings = try? await Backend.mealRatings() {
            apply(ratings)
        }
    }

    /// Marks a meal as disliked, or takes it off the list. Returns nil when it saved, or a message to show.
    @discardableResult
    func setDisliked(_ name: String, _ disliked: Bool) async -> String? {
        await save(name) { try await Backend.setMealDisliked(name: name, disliked: disliked) }
    }

    /// Makes a meal a Keeper (saving its recipe), or takes it off. Returns nil when it saved, or a message.
    @discardableResult
    func setLiked(_ meal: MealPlan.Meal, _ liked: Bool) async -> String? {
        await save(meal.name) { try await Backend.setMealLiked(meal, liked: liked) }
    }

    /// Takes a Keeper off the list by name (from Settings, where only the name is at hand).
    @discardableResult
    func unlike(_ name: String) async -> String? {
        let meal = liked.first { Self.key($0.name) == Self.key(name) }
            ?? MealPlan.Meal(name: name, servings: 0, timeMinutes: 0, ingredients: [], steps: [])
        return await setLiked(meal, false)
    }

    private func save(_ name: String, _ call: () async throws -> Backend.MealRatingsData) async -> String? {
        guard saving == nil else { return "Still saving the last change. Try again in a moment." }
        saving = name
        defer { saving = nil }
        do {
            apply(try await call())
            return nil
        } catch {
            return Backend.friendlyMessage(for: error)
        }
    }

    private func apply(_ ratings: Backend.MealRatingsData) {
        disliked = ratings.disliked
        liked = ratings.liked
        if let notes = ratings.notes { self.notes = notes }
        loaded = true
    }
}
