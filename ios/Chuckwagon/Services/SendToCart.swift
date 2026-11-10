import AuthenticationServices
import FirebaseFunctions
import Foundation
import UIKit

/// Sends a plan's grocery list to a store's cart.
///
/// Kroger: the phone talks to Kroger directly (Kroger blocks these calls from our
/// backend's servers). The backend only handles sign-in and hands out short-lived tokens.
/// Everything else: an Instacart shopping list the shopper opens in Instacart.
enum SendToCart {
    enum Route { case kroger(locationId: String), walmart, instacart }

    /// Kroger family store ids look like `kroger-{locationId}`, Walmart ids `walmart-{storeNo}`.
    /// Every other store goes through Instacart (Walmart isn't on Instacart).
    static func route(forStoreId storeId: String) -> Route {
        if storeId.hasPrefix("kroger-") { return .kroger(locationId: String(storeId.dropFirst("kroger-".count))) }
        if storeId.hasPrefix("walmart-") { return .walmart }
        return .instacart
    }

    struct Result {
        var added: [String] = []
        var notFound: [String] = []
    }

    enum CartError: LocalizedError {
        case notConnected, kroger(String), cancelled
        var errorDescription: String? {
            switch self {
            case .notConnected: "Connect your Kroger account first."
            case .kroger(let m): m
            case .cancelled: "Kroger sign-in was cancelled."
            }
        }
    }

    // MARK: Walmart

    /// Walmart's add-to-cart link: opens walmart.com (or the Walmart app) with the items in the cart.
    /// Only sale items carry a Walmart item id (`walmart-{storeNo}_wm-{itemId}`); the rest are
    /// returned in `notAdded` for the shopper to add by hand.
    static func walmartCartLink(items: [MealPlan.ListItem]) -> (url: URL?, added: [String], notAdded: [String]) {
        var parts: [String] = []
        var added: [String] = []
        var notAdded: [String] = []
        for item in items {
            if let id = walmartItemId(item.dealId) {
                parts.append("\(id)|\(max(1, item.buyCount))")
                added.append(item.item)
            } else {
                notAdded.append(item.item)
            }
        }
        guard !parts.isEmpty else { return (nil, added, notAdded) }
        var comps = URLComponents(string: "https://affil.walmart.com/cart/addToCart")!
        comps.queryItems = [.init(name: "items", value: parts.joined(separator: ","))]
        return (comps.url, added, notAdded)
    }

    static func walmartItemId(_ dealId: String?) -> String? {
        guard let dealId, dealId.hasPrefix("walmart-"), let r = dealId.range(of: "_wm-") else { return nil }
        let id = String(dealId[r.upperBound...])
        return !id.isEmpty && id.allSatisfy(\.isNumber) ? id : nil
    }

    // MARK: Instacart

    /// Builds an Instacart shopping list for one store's part of the plan and returns its link.
    static func instacartLink(planId: String, storeId: String?) async throws -> URL {
        var payload: [String: Any] = ["planId": planId]
        if let storeId { payload["storeId"] = storeId }
        let result = try await Functions.functions().httpsCallable("instacartShoppingList").call(payload)
        guard let s = (result.data as? [String: Any])?["url"] as? String, let url = URL(string: s) else {
            throw CartError.kroger("Instacart didn't send a link back.")
        }
        return url
    }

    // MARK: Kroger sign-in

    /// Opens Kroger's sign-in page. The backend keeps the sign-in so this is needed once.
    @MainActor
    static func connectKroger() async throws {
        let result = try await Functions.functions().httpsCallable("krogerConnectUrl").call()
        guard let s = (result.data as? [String: Any])?["url"] as? String, let url = URL(string: s) else {
            throw CartError.kroger("Couldn't start Kroger sign-in.")
        }
        let callback: URL = try await withCheckedThrowingContinuation { cont in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "chuckwagon") { url, error in
                if let url { cont.resume(returning: url) }
                else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { cont.resume(throwing: CartError.cancelled) }
                else { cont.resume(throwing: error ?? CartError.cancelled) }
            }
            session.presentationContextProvider = PresentationAnchor.shared
            session.prefersEphemeralWebBrowserSession = false
            session.start()
        }
        let status = URLComponents(url: callback, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "status" }?.value
        switch status {
        case "ok": return
        case "cancelled": throw CartError.cancelled
        case "expired": throw CartError.kroger("Kroger sign-in took too long. Please try again.")
        default: throw CartError.kroger("Kroger sign-in didn't finish. Please try again.")
        }
    }

    static func disconnectKroger() async throws {
        _ = try await Functions.functions().httpsCallable("krogerDisconnect").call()
    }

    private static func krogerAccessToken() async throws -> String {
        do {
            let result = try await Functions.functions().httpsCallable("krogerAccessToken").call()
            guard let token = (result.data as? [String: Any])?["accessToken"] as? String else { throw CartError.notConnected }
            return token
        } catch let error as NSError where error.domain == FunctionsErrorDomain
            && FunctionsErrorCode(rawValue: error.code) == .notFound {
            throw CartError.notConnected
        }
    }

    // MARK: Kroger cart

    /// Adds items to the shopper's Kroger cart for pickup. Sale items use the exact product;
    /// other items are matched by searching the store.
    static func addToKrogerCart(items: [MealPlan.ListItem], locationId: String) async throws -> Result {
        let token = try await krogerAccessToken()
        var result = Result()
        var lines: [(upc: String, quantity: Int)] = []
        for item in items {
            if let upc = saleUPC(item.dealId) {
                lines.append((upc, max(1, item.buyCount)))
                result.added.append(item.item)
            } else if let upc = try await searchUPC(term: searchTerm(item.item), locationId: locationId, token: token) {
                lines.append((upc, max(1, item.buyCount)))
                result.added.append(item.item)
            } else {
                result.notFound.append(item.item)
            }
        }
        guard !lines.isEmpty else { return result }

        var req = URLRequest(url: URL(string: "https://api.kroger.com/v1/cart/add")!)
        req.httpMethod = "PUT"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "items": lines.map { ["upc": $0.upc, "quantity": $0.quantity, "modality": "PICKUP"] },
        ])
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw CartError.notConnected }
        guard (200..<300).contains(status) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CartError.kroger("Kroger didn't take the list (\(status)). \(body.prefix(120))")
        }
        return result
    }

    /// Sale items are saved as `kroger-{locationId}_{productId}`; Kroger product ids are UPCs.
    static func saleUPC(_ dealId: String?) -> String? {
        guard let dealId, dealId.hasPrefix("kroger-"), let us = dealId.lastIndex(of: "_") else { return nil }
        let id = String(dealId[dealId.index(after: us)...])
        return id.allSatisfy(\.isNumber) && !id.isEmpty ? id : nil
    }

    /// "Chicken thighs, family pack (about 3 lb)" -> "Chicken thighs"
    static func searchTerm(_ item: String) -> String {
        let noParens = item.replacingOccurrences(of: "\\(.*?\\)", with: "", options: .regularExpression)
        let first = noParens.split(separator: ",").first.map(String.init) ?? noParens
        let t = first.trimmingCharacters(in: .whitespaces)
        return t.isEmpty ? item : t
    }

    /// Best match at the store: the first result that has a price there (so it's actually sold there).
    private static func searchUPC(term: String, locationId: String, token: String) async throws -> String? {
        var comps = URLComponents(string: "https://api.kroger.com/v1/products")!
        comps.queryItems = [
            .init(name: "filter.term", value: term),
            .init(name: "filter.locationId", value: locationId),
            .init(name: "filter.limit", value: "5"),
        ]
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw CartError.notConnected }
        guard (200..<300).contains(status) else { return nil }
        struct Page: Decodable {
            struct Product: Decodable {
                var upc: String?
                var productId: String
                var items: [Item]?
                struct Item: Decodable { var price: Price? }
                struct Price: Decodable { var regular: Double? }
            }
            var data: [Product]
        }
        let products = (try? JSONDecoder().decode(Page.self, from: data).data) ?? []
        let pick = products.first { ($0.items ?? []).contains { $0.price?.regular != nil } } ?? products.first
        return pick.map { $0.upc ?? $0.productId }
    }
}

/// Shows the Kroger sign-in sheet over the app's front window.
private final class PresentationAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = PresentationAnchor()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap(\.windows).first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
