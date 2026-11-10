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
    var favoriteStoreIds: [String] { didSet { defaults.set(favoriteStoreIds, forKey: "favoriteStoreIds") } }
    /// Shopper's ZIP and its approximate center (0 = unknown). Only the ZIP leaves the phone.
    var zip: String { didSet { defaults.set(zip, forKey: "zip") } }
    var latitude: Double { didSet { defaults.set(latitude, forKey: "latitude") } }
    var longitude: Double { didSet { defaults.set(longitude, forKey: "longitude") } }

    /// Stores to show: near the shopper's ZIP, or all of them if no ZIP is set yet.
    func nearby(_ stores: [Store], miles: Double = 30) -> [Store] {
        guard !zip.isEmpty else { return stores }
        return stores.filter { store in
            if store.geo != nil, latitude != 0 {
                return store.distanceMiles(fromLat: latitude, lng: longitude) ?? .infinity <= miles
            }
            if let storeZip = store.zip ?? store.address?.zipCode { return storeZip == zip }
            return true // older store records without a location
        }
    }

    static let diets = ["None", "Vegetarian", "Pescatarian", "No pork", "Gluten-free", "Dairy-free", "Low carb"]

    init() {
        hasOnboarded = defaults.bool(forKey: "hasOnboarded")
        householdSize = defaults.object(forKey: "householdSize") as? Int ?? 3
        mealCount = defaults.object(forKey: "mealCount") as? Int ?? 4
        diet = defaults.string(forKey: "diet") ?? "None"
        allergies = defaults.string(forKey: "allergies") ?? ""
        dislikes = defaults.string(forKey: "dislikes") ?? ""
        maxCookMinutes = defaults.object(forKey: "maxCookMinutes") as? Int ?? 45
        favoriteStoreIds = defaults.stringArray(forKey: "favoriteStoreIds") ?? []
        zip = defaults.string(forKey: "zip") ?? ""
        latitude = defaults.double(forKey: "latitude")
        longitude = defaults.double(forKey: "longitude")
    }
}
