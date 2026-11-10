import Foundation
import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions
import UIKit

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

    /// Whether this account has signed in with Kroger for send-to-cart (set only by the backend).
    static func isKrogerConnected() async throws -> Bool {
        guard let uid = Auth.auth().currentUser?.uid else { return false }
        let doc = try await db.collection("users").document(uid).getDocument()
        return doc.get("krogerConnected") as? Bool ?? false
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
            // A couple of spare meals to swap in, so a meal you don't like doesn't mean a new plan.
            "extraMeals": extraMealIdeas,
        ]
        if prefs.weeklyBudget > 0 {
            payload["budget"] = prefs.weeklyBudget
        }
        if !haveAtHome.trimmingCharacters(in: .whitespaces).isEmpty {
            payload["haveAtHome"] = haveAtHome
        }
        let result = try await Functions.functions().httpsCallable("planMealsForStore").call(payload)
        return try decodePlan(result.data)
    }

    /// How many extra meal ideas each plan comes with.
    static let extraMealIdeas = 2

    /// Picks which meal ideas to cook. The backend rebuilds the grocery list and totals
    /// from prices it already has (no new plan is used up) and returns the updated plan.
    static func chooseMeals(planId: String, meals: [String]) async throws -> MealPlan {
        let result = try await Functions.functions().httpsCallable("choosePlanMeals")
            .call(["planId": planId, "meals": meals])
        var plan = try decodePlan(result.data)
        plan.applyChecked()
        return plan
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

    /// What a receipt scan learned. Prices are per item, or per lb when soldBy is "WEIGHT".
    struct ReceiptScan: Decodable {
        struct Item: Decodable, Hashable {
            var name: String
            var size: String?
            var price: Double
            var soldBy: String
        }
        /// What the shopper earned for scanning.
        struct Reward: Decodable {
            var earned: Bool
            var reason: String?
            var extraPlansToday: Int
            var chefPickCredits: Int?
            var earnedChefPick: Bool?
            var receiptsToNextChefPick: Int?
        }
        var storeName: String?
        var items: [Item]
        var reward: Reward?
    }

    /// Sends a receipt photo to the backend, which saves the store's everyday prices.
    static func scanReceipt(storeId: String, image: UIImage) async throws -> ReceiptScan {
        guard let jpeg = image.scaledForUpload(maxSide: 2000).jpegData(compressionQuality: 0.7) else {
            throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that photo."])
        }
        let result = try await Functions.functions().httpsCallable("scanReceiptPhoto")
            .call(["storeId": storeId, "imageBase64": jpeg.base64EncodedString(), "mediaType": "image/jpeg"])
        let data = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(ReceiptScan.self, from: data)
    }

    private static func decodePlan(_ object: Any) throws -> MealPlan {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MealPlan.self, from: data)
    }
}

extension UIImage {
    /// A copy no larger than `maxSide` points on its longest side (receipts stay readable at 2000).
    func scaledForUpload(maxSide: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxSide else { return self }
        let scale = maxSide / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}
