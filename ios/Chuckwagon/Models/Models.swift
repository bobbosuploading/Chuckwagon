import Foundation
import FirebaseFirestore

/// A store, from Firestore `stores/{id}`.
struct Store: Identifiable, Codable, Hashable {
    @DocumentID var id: String?
    var chain: String
    var name: String
    var address: Address?
    var zip: String?
    var geo: Geo?
    /// Some collectors (Walmart) store coordinates at the top level instead of in `geo`.
    var lat: Double?
    var lng: Double?
    /// Shopper ZIPs the collector found this store near (within its search radius).
    var areaZips: [String]?
    /// Set when this store shows a nearby store's deals (same chain and price region).
    var dealsFrom: String?
    /// Set when this store's everyday prices come from another store of the chain.
    var everydayFrom: String?
    /// Where this store's prices come from, e.g. "Prices from Kroger, Sugar Land (14 mi away)".
    var pricesNote: String?

    /// The store whose deals to load for this one.
    var dealsStoreId: String? { dealsFrom ?? id }

    struct Geo: Codable, Hashable {
        var lat: Double
        var lng: Double
    }

    var coordinate: Geo? {
        if let geo { return geo }
        if let lat, let lng { return Geo(lat: lat, lng: lng) }
        return nil
    }

    func distanceMiles(fromLat lat: Double, lng: Double) -> Double? {
        guard let geo = coordinate else { return nil }
        let r = 3958.8, toRad = Double.pi / 180
        let dLat = (geo.lat - lat) * toRad, dLng = (geo.lng - lng) * toRad
        let a = sin(dLat / 2) * sin(dLat / 2) + cos(lat * toRad) * cos(geo.lat * toRad) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * r * asin(min(1, sqrt(a)))
    }

    struct Address: Codable, Hashable {
        var addressLine1: String?
        var city: String?
        var state: String?
        var zipCode: String?
    }

    var cityLine: String {
        [address?.addressLine1, address?.city].compactMap { $0 }.joined(separator: ", ")
    }
}

/// One sale item, from Firestore `deals/{storeId}_{productId}`.
struct Deal: Identifiable, Codable, Hashable {
    @DocumentID var id: String?
    var storeId: String
    var name: String
    var brand: String?
    var size: String?
    var soldBy: String?
    var category: String
    var imageUrl: String?
    var regularPrice: Double?
    var salePrice: Double?
    var savings: Double?
    var pctOff: Int
    /// Ad text when there's no simple price, e.g. "Buy 2, get pasta free".
    var promo: String?
    /// Set when the price is low enough to buy extra and the item keeps.
    var stockUp: StockUp?
    /// When the sale ends (ISO date), if known.
    var validTo: String?
    /// Where the deal came from; "shopper-ad" when read from a shopper's photo of a printed ad.
    var source: String?
    /// For shopper-ad deals: how many shoppers' scans showed it.
    var confirmations: Int?

    var fromShopperPhoto: Bool { source == "shopper-ad" }

    var perUnit: String { soldBy == "WEIGHT" ? "/lb" : "" }
}

/// "Worth buying extra": from the backend's stock-up rules (functions/src/stockUp.ts).
struct StockUp: Codable, Hashable {
    /// "great" (45%+ off or BOGO) or "good".
    var level: String
    /// e.g. "48% off" or "Buy 1, get 1 free".
    var reason: String
    /// "freezer", "pantry" or "fridge".
    var keep: String
    /// e.g. "Enough for 6 to 8 weeks, until the next sale".
    var howMuch: String
    var storage: String

    var isGreat: Bool { level == "great" }
    var symbol: String {
        switch keep {
        case "freezer": "snowflake"
        case "fridge": "refrigerator"
        default: "cabinet"
        }
    }
    var keepLabel: String {
        switch keep {
        case "freezer": "Freezes well"
        case "fridge": "Keeps in the fridge"
        default: "Keeps in the pantry"
        }
    }
}

/// The monthly Sam's Club stock-up list, from Firestore `clubLists/sams`.
struct ClubList: Codable {
    var chain: String
    var updatedAt: String?
    var items: [Item]

    var updatedDate: Date? {
        guard let updatedAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: updatedAt)
    }

    struct Item: Codable, Identifiable, Hashable {
        var id: String { name }
        var name: String
        var category: String
        var price: Double
        /// Price per lb, each, or per fl oz (see `unit`).
        var unitPrice: Double
        /// "lb", "ct" or "floz".
        var unit: String
        var keep: String?
        var storage: String?
        var compare: [Compare]
        /// Percent cheaper than the best grocery price. Nil with nothing to compare.
        var pctCheaper: Int?
        var worthIt: Bool

        struct Compare: Codable, Hashable {
            var chain: String
            var product: String
            var unitPrice: Double
        }

        func unitLabel(_ price: Double) -> String {
            switch unit {
            case "lb": "\(price.dollars)/lb"
            case "ct": "\(price.dollars) each"
            default: "\(price.dollars)/fl oz"
            }
        }

        var keepSymbol: String {
            switch keep {
            case "freezer": "snowflake"
            case "fridge": "refrigerator"
            default: "cabinet"
            }
        }
    }
}

enum DealCategory: String, CaseIterable, Identifiable {
    case meat, seafood, produce, dairy, bakery, pantry, frozen, household
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var symbol: String {
        switch self {
        case .meat: "fork.knife"
        case .seafood: "fish"
        case .produce: "carrot"
        case .dairy: "drop"
        case .bakery: "birthday.cake"
        case .pantry: "cabinet"
        case .frozen: "snowflake"
        case .household: "house"
        }
    }
}

/// The plan returned by the `planMealsForStore` Cloud Function.
struct MealPlan: Codable, Identifiable, Hashable {
    var id: String
    var storeId: String
    var storeName: String
    var model: String
    var meals: [Meal]
    var groceryList: [ListItem]
    var notes: String
    var totals: Totals
    var createdAt: String?
    var stores: [StoreTotal]?
    /// Only when the shopper set a budget.
    var budget: Budget?
    /// Only when extra meal ideas were asked for: every idea, and which ones are picked.
    /// `meals` and the grocery list cover just the picked ones.
    var options: Options?

    struct Options: Codable, Hashable {
        /// Every meal idea, the planner's main picks first.
        var meals: [Meal]
        /// Names of the picked meals.
        var chosen: [String]
        /// How many meals the shopper asked for.
        var mealCount: Int
    }

    struct Budget: Codable, Hashable {
        var amount: Double
        /// amount minus the estimated total; negative when over.
        var left: Double
        var fits: Bool
        /// True when the first try came in over budget and the planner trimmed it.
        var revised: Bool?
    }

    struct StoreTotal: Codable, Hashable {
        var storeId: String
        var storeName: String
        var items: Int
        var saleItems: Double
        var savings: Double
        /// Set when this store uses a nearby store's prices.
        var pricesNote: String?
    }
    /// Ids of grocery items the user has checked off (saved in Firestore as `checked`).
    var checked: [String]?

    var createdDate: Date? {
        guard let createdAt else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: createdAt)
    }

    /// Copies saved check marks onto the grocery list.
    mutating func applyChecked() {
        let ids = Set(checked ?? [])
        for i in groceryList.indices { groceryList[i].checked = ids.contains(groceryList[i].id) }
    }

    struct Meal: Codable, Hashable, Identifiable {
        var id: String { name }
        var name: String
        var servings: Int
        var timeMinutes: Int
        var ingredients: [Ingredient]
        var steps: [String]
    }

    struct Ingredient: Codable, Hashable {
        var item: String
        var amount: String
        var dealId: String?
    }

    struct ListItem: Codable, Hashable, Identifiable {
        var id: String { "\(aisle)|\(item)" }
        var aisle: String
        var item: String
        var buyCount: Int
        var quantityNote: String
        var dealId: String?
        var onSale: Bool
        var salePrice: Double?
        var regularPrice: Double?
        var lineTotal: Double?
        var lineSavings: Double?
        var forMeals: [String]
        /// Which store to buy it at (multi-store plans). Older plans don't have it.
        var storeName: String?
        /// Worth buying extra of. Older plans don't have it.
        var stockUp: StockUp?
        /// For items not on sale: "store", "receipt", "nearby" (same chain, the store this one
        /// shares prices with), or "estimate" (another chain's price stands in).
        var priceSource: String?
        /// For items not on sale: the product that was priced.
        var pricedAs: String?
        var storeId: String?
        /// Set on the phone only; the backend never sends it.
        var checked = false

        enum CodingKeys: String, CodingKey {
            case aisle, item, buyCount, quantityNote, dealId, onSale, salePrice
            case regularPrice, lineTotal, lineSavings, forMeals, storeName, priceSource, pricedAs, stockUp, storeId
        }
    }

    struct Totals: Codable, Hashable {
        var saleItems: Double
        var savings: Double
        var itemsNotPriced: Int
        /// Items not on sale at everyday prices. Older plans don't have it.
        var regularItems: Double?
        /// Sale + regular items (unpriced items not included). Older plans don't have it.
        var estimatedTotal: Double?
        /// Estimated total divided by all servings. Older plans don't have it.
        var perServing: Double?
    }
}

extension Double {
    var dollars: String { formatted(.currency(code: "USD")) }
    /// "$60" with no cents, for budgets.
    var wholeDollars: String { formatted(.currency(code: "USD").precision(.fractionLength(0))) }
}
