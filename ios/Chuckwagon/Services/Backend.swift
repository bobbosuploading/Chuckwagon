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
        // Deals from shoppers' ad photos can outlast their ad until the next scan clears them.
        let today = Date.now.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
        return snap.documents.compactMap { try? $0.data(as: Deal.self) }
            .filter { ($0.validTo.map { String($0.prefix(10)) } ?? today) >= today }
    }

    /// How many deals a store has, for the store list. A count costs about one read per
    /// 1,000 deals, so this stays cheap. It can include a few expired ad deals.
    static func dealCount(storeId: String) async throws -> Int {
        let snap = try await db.collection("deals").whereField("storeId", isEqualTo: storeId)
            .count.getAggregation(source: .server)
        return snap.count.intValue
    }

    /// The monthly Sam's Club stock-up list, or nil before the first one is made.
    static func clubList() async throws -> ClubList? {
        let doc = try await db.collection("clubLists").document("sams").getDocument()
        guard doc.exists else { return nil }
        return try doc.data(as: ClubList.self)
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
            /// Everyday price (the regular price when this was a sale and we know it).
            var price: Double
            var soldBy: String
            /// What was paid, when it was a sale.
            var salePrice: Double?
            /// "receipt", "ad" or "below-usual" when it was a sale.
            var saleReason: String?
            /// False when it was a sale with no known regular price, so it wasn't saved.
            var saved: Bool?
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

    /// What a weekly ad scan read. Prices are per item, or per lb when soldBy is "WEIGHT".
    struct AdScan: Decodable {
        struct Deal: Decodable, Hashable {
            var name: String
            var brand: String?
            var size: String?
            var soldBy: String
            var salePrice: Double?
            var regularPrice: Double?
            var promo: String?
            /// How many shoppers' scans showed this same deal.
            var confirmations: Int
        }
        var storeId: String
        var storeName: String
        /// True when this scan added the store.
        var newStore: Bool
        var validFrom: String?
        var validTo: String
        var deals: [Deal]
        var reward: ReceiptScan.Reward?
    }

    /// Sends one page of a printed weekly ad. Pass a store, or nil to add the store named on
    /// the ad near the shopper's ZIP.
    static func scanAd(storeId: String?, zip: String, latitude: Double, longitude: Double, image: UIImage) async throws -> AdScan {
        guard let jpeg = image.scaledForUpload(maxSide: 2000).jpegData(compressionQuality: 0.7) else {
            throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that photo."])
        }
        var data: [String: Any] = ["imageBase64": jpeg.base64EncodedString(), "mediaType": "image/jpeg"]
        if let storeId {
            data["storeId"] = storeId
        } else {
            data["zip"] = zip
            if latitude != 0 { data["lat"] = latitude; data["lng"] = longitude }
        }
        let result = try await Functions.functions().httpsCallable("scanAdPhoto").call(data)
        let json = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(AdScan.self, from: json)
    }

    /// Deals shoppers shared from social media for a store: its own, plus ones for every store
    /// of the chain. Hides ended deals and ones shoppers said are gone. Newest first.
    static func sharedDeals(store: Store) async throws -> [SharedDeal] {
        guard let storeId = store.id else { return [] }
        let key = SharedDeal.chainKey(store.chain)
        async let mine = db.collection("sharedDeals")
            .whereField("storeId", isEqualTo: storeId)
            .whereField("status", isEqualTo: "active")
            .getDocuments()
        async let chainWide = db.collection("sharedDeals")
            .whereField("chainKey", isEqualTo: key)
            .whereField("scope", isEqualTo: "chain")
            .whereField("status", isEqualTo: "active")
            .getDocuments()
        let today = Date.now.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
        var seen = Set<String>()
        let docs = try await mine.documents + chainWide.documents
        return docs
            .compactMap { try? $0.data(as: SharedDeal.self) }
            .filter { $0.validTo >= today && seen.insert($0.id ?? "").inserted }
            .sorted { ($0.updatedAt?.dateValue() ?? .distantPast) > ($1.updatedAt?.dateValue() ?? .distantPast) }
    }

    /// What sharing a deal added.
    struct ShareResult: Decodable {
        struct Deal: Decodable, Hashable {
            var id: String
            var name: String
            var brand: String?
            var size: String?
            var soldBy: String
            var salePrice: Double?
            var regularPrice: Double?
            var promo: String?
            /// True when another shopper already shared it (this counts as "still there").
            var alreadyShared: Bool
        }
        var storeId: String
        var storeName: String
        /// "one-store" or "chain".
        var scope: String
        var clearance: Bool
        var validTo: String
        var endDateFromPost: Bool
        var deals: [Deal]
    }

    /// Shares a deal from social media: a screenshot, a link and/or the post's text.
    static func shareDeal(storeId: String, image: UIImage?, url: String?, text: String?) async throws -> ShareResult {
        var data: [String: Any] = ["storeId": storeId]
        if let image {
            guard let jpeg = image.scaledForUpload(maxSide: 2000).jpegData(compressionQuality: 0.7) else {
                throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that picture."])
            }
            data["imageBase64"] = jpeg.base64EncodedString()
            data["mediaType"] = "image/jpeg"
        }
        if let url, !url.isEmpty { data["url"] = url }
        if let text, !text.isEmpty { data["text"] = text }
        let result = try await Functions.functions().httpsCallable("shareDealPost").call(data)
        let json = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(ShareResult.self, from: json)
    }

    /// "Still there" (here = true) or "Gone" on a shared deal.
    static func voteSharedDeal(id: String, stillThere: Bool) async throws {
        _ = try await Functions.functions().httpsCallable("voteSharedDealPost")
            .call(["id": id, "vote": stillThere ? "here" : "gone"])
    }

    private static func decodePlan(_ object: Any) throws -> MealPlan {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MealPlan.self, from: data)
    }
}
