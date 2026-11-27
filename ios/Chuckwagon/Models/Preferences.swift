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
    /// The stores picked for the last meal plan, so the next one starts with the same ones.
    var planStoreIds: [String] { didSet { defaults.set(planStoreIds, forKey: "planStoreIds") } }
    /// Shopper's ZIP and its approximate center (0 = unknown). Only the ZIP leaves the phone.
    var zip: String { didSet { defaults.set(zip, forKey: "zip") } }
    var latitude: Double { didSet { defaults.set(latitude, forKey: "latitude") } }
    var longitude: Double { didSet { defaults.set(longitude, forKey: "longitude") } }
    /// How far from the ZIP to show stores, in miles.
    var storeRadius: Int { didSet { defaults.set(storeRadius, forKey: "storeRadius") } }
    /// Notifications (opt-in): "new deals are in" for the shopper's stores, and a weekly
    /// planning reminder on planReminderDay (0 = Sunday … 6, -1 = off) at planReminderHour.
    var notifyNewDeals: Bool { didSet { defaults.set(notifyNewDeals, forKey: "notifyNewDeals") } }
    var planReminderDay: Int { didSet { defaults.set(planReminderDay, forKey: "planReminderDay") } }
    var planReminderHour: Int { didSet { defaults.set(planReminderHour, forKey: "planReminderHour") } }

    /// Sale alerts (opt-in): ready-made watch items (ids from SaleWatch.items), the shopper's
    /// own items, the make-it-yourself checks, and the smallest saving worth a notification.
    var watchItems: [String] { didSet { defaults.set(watchItems, forKey: "watchItems") } }
    var watchCustom: [String] { didSet { defaults.set(watchCustom, forKey: "watchCustom") } }
    var watchBacon: Bool { didSet { defaults.set(watchBacon, forKey: "watchBacon") } }
    var watchGroundBeef: Bool { didSet { defaults.set(watchGroundBeef, forKey: "watchGroundBeef") } }
    var watchJerky: Bool { didSet { defaults.set(watchJerky, forKey: "watchJerky") } }
    var watchAlertPct: Int { didSet { defaults.set(watchAlertPct, forKey: "watchAlertPct") } }
    /// Keep the screen on while the shopping list or a recipe is open: minutes, 0 = off,
    /// -1 = as long as it's open (ScreenAwake).
    var keepScreenOnMinutes: Int { didSet { defaults.set(keepScreenOnMinutes, forKey: "keepScreenOnMinutes") } }

    var wantsSaleAlerts: Bool { !watchItems.isEmpty || !watchCustom.isEmpty || watchBacon || watchGroundBeef || watchJerky }
    var wantsNotifications: Bool { notifyNewDeals || planReminderDay >= 0 || wantsSaleAlerts }

    /// What the backend gets for sale alerts (functions/src/saleWatch.ts, cleanWatchSettings).
    var watchPayload: [String: Any] {
        ["items": watchItems, "custom": watchCustom, "bacon": watchBacon, "groundBeef": watchGroundBeef,
         "jerky": watchJerky, "pct": watchAlertPct]
    }

    /// Changes to sale alerts, in one string, so a change can be noticed and synced.
    var watchSignature: String {
        "\(watchItems.sorted())|\(watchCustom)|\(watchBacon)|\(watchGroundBeef)|\(watchJerky)|\(watchAlertPct)"
    }

    /// Radius choices. The collectors look 50 miles out from each area, so going past 50
    /// would show nothing new without pulling more data.
    static let radiusChoices = [10, 20, 30, 50]
    static let defaultRadius = 30

    /// Stores to show: near the shopper's ZIP, or all of them if no ZIP is set yet.
    func nearby(_ stores: [Store]) -> [Store] {
        let miles = Double(storeRadius)
        guard !zip.isEmpty else { return stores }
        return stores.filter { store in
            if store.coordinate != nil, latitude != 0 {
                return store.distanceMiles(fromLat: latitude, lng: longitude) ?? .infinity <= miles
            }
            // No map position to measure from: trust the collector's list of ZIPs it searched.
            if store.areaZips?.contains(zip) == true { return true }
            if let storeZip = store.zip ?? store.address?.zipCode { return storeZip == zip }
            return true // older store records without a location
        }
    }

    /// Nearby stores, closest first (stores without a map position go last, by name).
    func nearbyClosestFirst(_ stores: [Store]) -> [Store] {
        let lat = latitude, lng = longitude
        let miles: (Store) -> Double? = { store in
            lat == 0 ? nil : store.distanceMiles(fromLat: lat, lng: lng)
        }
        return nearby(stores).sorted { a, b in
            switch (miles(a), miles(b)) {
            case let (x?, y?): return x < y
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return a.name < b.name
            }
        }
    }

    /// Older installs (or a failed lookup) saved a ZIP without map coordinates, which hides
    /// stores outside that exact ZIP. Look the coordinates up again when that happens.
    @MainActor
    func fillInCoordinatesIfMissing() async {
        guard !zip.isEmpty, latitude == 0 else { return }
        let lookedUp = zip
        guard let coord = await Location.coordinates(forZip: lookedUp), zip == lookedUp else { return }
        latitude = coord.latitude
        longitude = coord.longitude
    }

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
        planStoreIds = defaults.stringArray(forKey: "planStoreIds") ?? []
        zip = defaults.string(forKey: "zip") ?? ""
        latitude = defaults.double(forKey: "latitude")
        longitude = defaults.double(forKey: "longitude")
        let radius = defaults.object(forKey: "storeRadius") as? Int ?? Self.defaultRadius
        storeRadius = Self.radiusChoices.contains(radius) ? radius : Self.defaultRadius
        notifyNewDeals = defaults.bool(forKey: "notifyNewDeals")
        planReminderDay = defaults.object(forKey: "planReminderDay") as? Int ?? -1
        planReminderHour = defaults.object(forKey: "planReminderHour") as? Int ?? 17
        watchItems = defaults.stringArray(forKey: "watchItems") ?? []
        watchCustom = defaults.stringArray(forKey: "watchCustom") ?? []
        watchBacon = defaults.bool(forKey: "watchBacon")
        watchGroundBeef = defaults.bool(forKey: "watchGroundBeef")
        watchJerky = defaults.bool(forKey: "watchJerky")
        watchAlertPct = defaults.object(forKey: "watchAlertPct") as? Int ?? 30
        keepScreenOnMinutes = defaults.object(forKey: "keepScreenOnMinutes") as? Int ?? 30
    }
}
