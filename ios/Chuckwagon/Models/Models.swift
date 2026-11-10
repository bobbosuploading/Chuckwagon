import Foundation
import FirebaseFirestore

/// A store, from Firestore `stores/{id}`.
struct Store: Identifiable, Codable, Hashable {
    @DocumentID var id: String?
    var chain: String
    var name: String
    var address: Address?

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
    var regularPrice: Double
    var salePrice: Double
    var savings: Double
    var pctOff: Int

    var perUnit: String { soldBy == "WEIGHT" ? "/lb" : "" }
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
        /// Set on the phone only; the backend never sends it.
        var checked = false

        enum CodingKeys: String, CodingKey {
            case aisle, item, buyCount, quantityNote, dealId, onSale, salePrice
            case regularPrice, lineTotal, lineSavings, forMeals
        }
    }

    struct Totals: Codable, Hashable {
        var saleItems: Double
        var savings: Double
        var itemsNotPriced: Int
    }
}

extension Double {
    var dollars: String { formatted(.currency(code: "USD")) }
}
