import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions

/// Everything the app reads from or asks of Firebase.
enum Backend {
    private static var db: Firestore { Firestore.firestore() }

    /// Sign in anonymously so Firestore rules and the meal planner know who's asking.
    static func signIn() async throws {
        if Auth.auth().currentUser == nil {
            _ = try await Auth.auth().signInAnonymously()
        }
    }

    static func stores() async throws -> [Store] {
        let snap = try await db.collection("stores").getDocuments()
        return snap.documents.compactMap { try? $0.data(as: Store.self) }
            .sorted { $0.name < $1.name }
    }

    /// Current deals at a store, biggest discounts first.
    static func deals(storeId: String, category: DealCategory?) async throws -> [Deal] {
        var query: Query = db.collection("deals").whereField("storeId", isEqualTo: storeId)
        if let category {
            query = query.whereField("category", isEqualTo: category.rawValue)
        }
        let snap = try await query.order(by: "pctOff", descending: true).limit(to: 200).getDocuments()
        return snap.documents.compactMap { try? $0.data(as: Deal.self) }
    }

    /// "Headed to [store]": asks the backend for meals and a grocery list.
    static func planMeals(storeId: String, prefs: Preferences, haveAtHome: String, premium: Bool = false) async throws -> MealPlan {
        var payload: [String: Any] = [
            "storeId": storeId,
            "mealCount": prefs.mealCount,
            "householdSize": prefs.householdSize,
            "diet": prefs.diet == "None" ? "none" : prefs.diet,
            "allergies": prefs.allergies,
            "dislikes": prefs.dislikes,
            "maxCookMinutes": prefs.maxCookMinutes,
            "premium": premium,
        ]
        if !haveAtHome.trimmingCharacters(in: .whitespaces).isEmpty {
            payload["haveAtHome"] = haveAtHome
        }
        let result = try await Functions.functions().httpsCallable("planMealsForStore").call(payload)
        let data = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(MealPlan.self, from: data)
    }
}
