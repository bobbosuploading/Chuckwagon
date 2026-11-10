import SwiftUI

/// The shopper's settings, kept on the device for now.
@Observable
final class Preferences {
    private let defaults = UserDefaults.standard

    var hasOnboarded: Bool { didSet { defaults.set(hasOnboarded, forKey: "hasOnboarded") } }
    var householdSize: Int { didSet { defaults.set(householdSize, forKey: "householdSize") } }
    var mealCount: Int { didSet { defaults.set(mealCount, forKey: "mealCount") } }
    var diet: String { didSet { defaults.set(diet, forKey: "diet") } }
    var allergies: String { didSet { defaults.set(allergies, forKey: "allergies") } }
    var dislikes: String { didSet { defaults.set(dislikes, forKey: "dislikes") } }
    var maxCookMinutes: Int { didSet { defaults.set(maxCookMinutes, forKey: "maxCookMinutes") } }
    /// Weekly grocery budget in whole dollars; 0 means no budget.
    var weeklyBudget: Int { didSet { defaults.set(weeklyBudget, forKey: "weeklyBudget") } }
    var favoriteStoreIds: [String] { didSet { defaults.set(favoriteStoreIds, forKey: "favoriteStoreIds") } }

    static let defaultBudget = 60

    static let diets = ["None", "Vegetarian", "Pescatarian", "No pork", "Gluten-free", "Dairy-free", "Low carb"]

    init() {
        hasOnboarded = defaults.bool(forKey: "hasOnboarded")
        householdSize = defaults.object(forKey: "householdSize") as? Int ?? 3
        mealCount = defaults.object(forKey: "mealCount") as? Int ?? 4
        diet = defaults.string(forKey: "diet") ?? "None"
        allergies = defaults.string(forKey: "allergies") ?? ""
        dislikes = defaults.string(forKey: "dislikes") ?? ""
        maxCookMinutes = defaults.object(forKey: "maxCookMinutes") as? Int ?? 45
        weeklyBudget = defaults.object(forKey: "weeklyBudget") as? Int ?? 0
        favoriteStoreIds = defaults.stringArray(forKey: "favoriteStoreIds") ?? []
    }
}
