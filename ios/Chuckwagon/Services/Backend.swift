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

    /// Adds the shopper's ZIP to the list of areas we collect deals for.
    /// Returns "ready", "pending" (first collection on its way) or "waitlist" (beta is full).
    @discardableResult
    static func registerArea(zip: String) async throws -> String {
        let result = try await Functions.functions().httpsCallable("registerArea").call(["zip": zip])
        return (result.data as? [String: Any])?["status"] as? String ?? "pending"
    }

    /// Whether this account has premium (set only by the backend).
    static func isPremium() async throws -> Bool {
        guard let uid = Auth.auth().currentUser?.uid else { return false }
        let doc = try await db.collection("users").document(uid).getDocument()
        return doc.get("premium") as? Bool ?? false
    }

    /// Unlocks premium with a tester code.
    static func redeemCode(_ code: String) async throws {
        _ = try await Functions.functions().httpsCallable("redeemTesterCode").call(["code": code])
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
    static func planMeals(storeId: String, alsoStoreIds: [String] = [], prefs: Preferences, haveAtHome: String, premium: Bool = false) async throws -> MealPlan {
        var payload: [String: Any] = [
            "storeId": storeId,
            "storeIds": [storeId] + alsoStoreIds,
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
        return try decodePlan(result.data)
    }

    /// Plans this user has made, newest first.
    static func myPlans() async throws -> [MealPlan] {
        guard let uid = Auth.auth().currentUser?.uid else { return [] }
        let snap = try await db.collection("plans")
            .whereField("uid", isEqualTo: uid)
            .order(by: "createdAt", descending: true)
            .limit(to: 30)
            .getDocuments()
        return snap.documents.compactMap { doc in
            var data = doc.data()
            data["id"] = doc.documentID
            var plan = try? decodePlan(data)
            plan?.applyChecked()
            return plan
        }
    }

    /// Saves which grocery items are checked off.
    static func saveChecked(planId: String, itemIds: [String]) async throws {
        try await db.collection("plans").document(planId).updateData(["checked": itemIds])
    }

    static func deletePlan(id: String) async throws {
        try await db.collection("plans").document(id).delete()
    }

    private static func decodePlan(_ object: Any) throws -> MealPlan {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MealPlan.self, from: data)
    }
}
