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

    /// "Build a meal plan": asks the backend for meals and a grocery list from one to three stores
    /// (`storeId` first, then `alsoStoreIds`).
    /// `onProgress` gets live updates while the plan is made (meals as they're written, then
    /// each step), on the main thread.
    static func planMeals(storeId: String, alsoStoreIds: [String] = [], prefs: Preferences, haveAtHome: String, premium: Bool = false,
                          includeMeals: [MealPlan.Meal] = [],
                          onProgress: @escaping @MainActor @Sendable (PlanProgress) -> Void = { _ in }) async throws -> MealPlan {
        // Watch planProgress/{id}; the backend writes it as the plan takes shape and deletes it when done.
        let progressId = UUID().uuidString
        let listener = db.collection("planProgress").document(progressId).addSnapshotListener { snap, _ in
            guard let snap, snap.exists, let progress = try? snap.data(as: PlanProgress.self) else { return }
            Task { @MainActor in onProgress(progress) }
        }
        defer { listener.remove() }
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
            "progressId": progressId,
        ]
        if prefs.weeklyBudget > 0 {
            payload["budget"] = prefs.weeklyBudget
        }
        if !haveAtHome.trimmingCharacters(in: .whitespaces).isEmpty {
            payload["haveAtHome"] = haveAtHome
        }
        // Saved meals to build around: their recipes, so the planner can keep them as they are.
        if !includeMeals.isEmpty {
            payload["includeMeals"] = includeMeals.map { meal in
                [
                    "name": meal.name,
                    "ingredients": meal.ingredients.map { ["item": $0.item, "amount": $0.amount] },
                    "steps": meal.steps,
                ] as [String: Any]
            }
        }
        let callable = Functions.functions().httpsCallable("planMealsForStore")
        // A Chef's pick plan can take several minutes; the function itself allows 540 s.
        callable.timeoutInterval = 560
        let started = Date.now
        do {
            return try decodePlan(try await callable.call(payload).data)
        } catch where isTimeout(error) || isConnectionLost(error) {
            // The plan may still finish and be saved on the server. Look for it before giving up.
            if let plan = try? await findPlan(madeAfter: started, waitingUntil: started.addingTimeInterval(600)) {
                return plan
            }
            throw error
        }
    }

    /// Looks for a plan of this user's saved after `date`, checking every 10 seconds until
    /// `deadline`. Used when the app stopped waiting but the server kept going.
    private static func findPlan(madeAfter date: Date, waitingUntil deadline: Date) async throws -> MealPlan? {
        // A little slack for the phone's clock being ahead of the server's.
        let since = date.addingTimeInterval(-30)
        while true {
            if let plan = try await myPlans().first(where: { ($0.createdDate ?? .distantPast) > since }) {
                return plan
            }
            if Date.now >= deadline { return nil }
            try await Task.sleep(for: .seconds(10))
        }
    }

    private static func isTimeout(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == FunctionsErrorDomain { return FunctionsErrorCode(rawValue: error.code) == .deadlineExceeded }
        return error.domain == NSURLErrorDomain && error.code == NSURLErrorTimedOut
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

    /// A link to a meal, or to the whole plan when `meal` is nil. The backend copies it to
    /// `sharedMeals` (nothing else of yours is shared); sharing the same thing again gives the same link.
    static func shareLink(planId: String, meal: String?) async throws -> ShareLinks.Link {
        var data: [String: Any] = ["planId": planId]
        if let meal { data["meal"] = meal }
        let result = try await Functions.functions().httpsCallable("shareMealLink").call(data)
        guard let dict = result.data as? [String: Any],
              let id = dict["id"] as? String,
              let url = (dict["url"] as? String).flatMap(URL.init(string:)) else {
            throw URLError(.badServerResponse)
        }
        return ShareLinks.Link(id: id, url: url, title: dict["title"] as? String ?? "A meal from Chuckwagon")
    }

    /// A meal or plan someone shared, by the id in its link. Readable without signing in.
    static func sharedMeals(id: String) async throws -> SharedMeals? {
        let doc = try await db.collection("sharedMeals").document(id).getDocument()
        guard doc.exists else { return nil }
        return try doc.data(as: SharedMeals.self)
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
        /// The store the prices were saved under, and whether this scan added it.
        var storeId: String?
        var newStore: Bool?
        var items: [Item]
        var reward: Reward?
    }

    /// Sends a receipt photo to the backend, which saves the store's everyday prices.
    /// With no storeId, the store is one that isn't in the shopper's list: it's named from the
    /// receipt (or storeName, when typed) and added near their ZIP.
    static func scanReceipt(storeId: String?, storeName: String = "", zip: String = "", latitude: Double = 0, longitude: Double = 0, image: UIImage) async throws -> ReceiptScan {
        guard let jpeg = image.uploadJPEG() else {
            throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that photo."])
        }
        var data: [String: Any] = ["imageBase64": jpeg.base64EncodedString(), "mediaType": "image/jpeg"]
        addStore(to: &data, storeId: storeId, storeName: storeName, zip: zip, latitude: latitude, longitude: longitude)
        let result = try await callPhotoFunction("scanReceiptPhoto", data)
        let json = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(ReceiptScan.self, from: json)
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
    static func scanAd(storeId: String?, storeName: String = "", zip: String, latitude: Double, longitude: Double, image: UIImage) async throws -> AdScan {
        guard let jpeg = image.uploadJPEG() else {
            throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that photo."])
        }
        var data: [String: Any] = ["imageBase64": jpeg.base64EncodedString(), "mediaType": "image/jpeg"]
        addStore(to: &data, storeId: storeId, storeName: storeName, zip: zip, latitude: latitude, longitude: longitude)
        let result = try await callPhotoFunction("scanAdPhoto", data)
        let json = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(AdScan.self, from: json)
    }

    /// A photo scan's store: one from the list, or a store that isn't in Chuckwagon yet (by name, near the ZIP).
    private static func addStore(to data: inout [String: Any], storeId: String?, storeName: String, zip: String, latitude: Double, longitude: Double) {
        if let storeId {
            data["storeId"] = storeId
            return
        }
        data["zip"] = zip
        let name = storeName.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { data["storeName"] = name }
        if latitude != 0 { data["lat"] = latitude; data["lng"] = longitude }
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
            guard let jpeg = image.uploadJPEG() else {
                throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Couldn't read that picture."])
            }
            data["imageBase64"] = jpeg.base64EncodedString()
            data["mediaType"] = "image/jpeg"
        }
        if let url, !url.isEmpty { data["url"] = url }
        if let text, !text.isEmpty { data["text"] = text }
        let result = try await callPhotoFunction("shareDealPost", data)
        let json = try JSONSerialization.data(withJSONObject: result.data)
        return try JSONDecoder().decode(ShareResult.self, from: json)
    }

    /// "Still there" (here = true) or "Gone" on a shared deal.
    static func voteSharedDeal(id: String, stillThere: Bool) async throws {
        _ = try await Functions.functions().httpsCallable("voteSharedDealPost")
            .call(["id": id, "vote": stillThere ? "here" : "gone"])
    }

    /// Calls a function that reads a photo. These can be slow on a weak cell signal (the upload)
    /// and while the model reads a long receipt, so they get longer than Firebase's 70-second
    /// default: a bit more than the functions' own 240 seconds (functions/src/index.ts).
    /// If the connection drops before the request gets through, it tries once more.
    private static func callPhotoFunction(_ name: String, _ data: [String: Any]) async throws -> HTTPSCallableResult {
        let callable = Functions.functions().httpsCallable(name)
        callable.timeoutInterval = 250
        do {
            return try await callable.call(data)
        } catch where isConnectionLost(error) {
            try await Task.sleep(for: .seconds(2))
            return try await callable.call(data)
        }
    }

    /// True when the request likely never reached the server (no signal, connection dropped).
    private static func isConnectionLost(_ error: Error) -> Bool {
        let error = error as NSError
        if error.domain == FunctionsErrorDomain, FunctionsErrorCode(rawValue: error.code) == .unavailable { return true }
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError { return isConnectionLost(underlying) }
        return error.domain == NSURLErrorDomain && [
            NSURLErrorNetworkConnectionLost, NSURLErrorNotConnectedToInternet, NSURLErrorCannotConnectToHost,
        ].contains(error.code)
    }

    /// Words a shopper can act on, instead of "DEADLINE EXCEEDED" or "INTERNAL".
    /// Our functions already send friendly words for problems the shopper can fix.
    /// `planning` is for meal plans, where a timeout means the model was slow, not the signal.
    static func friendlyMessage(for error: Error, planning: Bool = false) -> String {
        let nsError = error as NSError
        let slowMessage = planning ? slowPlanMessage : slowMessage
        if nsError.domain == NSURLErrorDomain {
            return nsError.code == NSURLErrorTimedOut ? slowMessage : offlineMessage
        }
        guard nsError.domain == FunctionsErrorDomain, let code = FunctionsErrorCode(rawValue: nsError.code) else {
            return error.localizedDescription
        }
        switch code {
        case .deadlineExceeded: return slowMessage
        case .unavailable: return offlineMessage
        case .unauthenticated: return "You're signed out. Close the app, open it again and try once more."
        case .internal, .unknown, .dataLoss:
            // Older functions sent raw error text here; only show it when it reads like ours.
            let text = error.localizedDescription
            return text.count > 12 && text != text.uppercased() && !text.contains("{") ? text : "Something went wrong on our end. Please try again in a minute."
        default: return error.localizedDescription
        }
    }

    private static let slowMessage = "That took too long, probably because of a weak signal. Try again on Wi-Fi or where you have better service."
    private static let slowPlanMessage = "Your plan is taking longer than usual. If it finishes, it will show up in My plans. Otherwise, please try again in a few minutes."
    private static let offlineMessage = "Couldn't reach Chuckwagon. Check your connection and try again."

    private static func decodePlan(_ object: Any) throws -> MealPlan {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MealPlan.self, from: data)
    }
}
