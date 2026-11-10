import SwiftUI

/// "Send to cart" buttons on the grocery list, one per store in the plan.
/// Kroger stores go straight into the shopper's Kroger cart; other stores open an Instacart list.
struct SendToCartSection: View {
    let plan: MealPlan
    @Environment(\.openURL) private var openURL
    @State private var busyStore: String?
    @State private var message: (title: String, body: String)?
    @State private var needsKrogerSignIn: String?
    @State private var walmartLink: (url: URL, body: String)?

    private var stores: [(id: String, name: String)] {
        if let s = plan.stores, !s.isEmpty { return s.map { ($0.storeId, $0.storeName) } }
        return [(plan.storeId, plan.storeName)]
    }

    /// Items still to buy at a store (checked-off items are skipped).
    private func items(at storeId: String) -> [MealPlan.ListItem] {
        plan.groceryList.filter { !$0.checked && ($0.storeId ?? plan.storeId) == storeId }
    }

    var body: some View {
        Section {
            ForEach(stores, id: \.id) { store in
                let left = items(at: store.id).count
                if case .share = SendToCart.route(forStoreId: store.id) {
                    ShareLink(item: SendToCart.shareText(storeName: store.name, items: items(at: store.id))) {
                        row(store: store, left: left)
                    }
                    .disabled(left == 0)
                } else {
                    Button {
                        Task { await send(storeId: store.id, storeName: store.name) }
                    } label: {
                        row(store: store, left: left)
                    }
                    .disabled(busyStore != nil || left == 0)
                }
            }
        } header: {
            Text("Send to cart or share")
        } footer: {
            Text("Prices in the cart may differ a little from the ad. Items you check off are left out.")
        }
        .alert(message?.title ?? "", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK") { message = nil }
        } message: {
            Text(message?.body ?? "")
        }
        .alert("Walmart cart", isPresented: Binding(get: { walmartLink != nil }, set: { if !$0 { walmartLink = nil } })) {
            Button("Open Walmart") {
                if let url = walmartLink?.url { openURL(url) }
                walmartLink = nil
            }
            Button("Cancel", role: .cancel) { walmartLink = nil }
        } message: {
            Text(walmartLink?.body ?? "")
        }
        .alert("Connect Kroger", isPresented: Binding(get: { needsKrogerSignIn != nil }, set: { if !$0 { needsKrogerSignIn = nil } })) {
            Button("Connect") {
                let storeId = needsKrogerSignIn
                needsKrogerSignIn = nil
                if let storeId { Task { await connectThenSend(storeId: storeId) } }
            }
            Button("Not now", role: .cancel) { needsKrogerSignIn = nil }
        } message: {
            Text("Sign in with your Kroger account once, and Chuckwagon can add your list to your cart for pickup.")
        }
    }

    private func row(store: (id: String, name: String), left: Int) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon(store.id)).foregroundStyle(Theme.red).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(label(store.id, store.name)).font(Theme.body(.subheadline, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                Text(left == 0 ? "Everything is checked off" : "\(left) item\(left == 1 ? "" : "s") not checked off")
                    .font(Theme.body(.caption)).foregroundStyle(Theme.ink.opacity(0.6))
            }
            Spacer()
            if busyStore == store.id { ProgressView() }
            else { Image(systemName: "chevron.right").font(.caption.bold()).foregroundStyle(.tertiary) }
        }
    }

    private func icon(_ storeId: String) -> String {
        switch SendToCart.route(forStoreId: storeId) {
        case .kroger, .walmart: return "cart.fill.badge.plus"
        case .instacart: return "bag.fill"
        case .share: return "square.and.arrow.up"
        }
    }

    private func label(_ storeId: String, _ name: String) -> String {
        switch SendToCart.route(forStoreId: storeId) {
        case .kroger: return "Add to my \(name) cart"
        case .walmart: return "Add to my Walmart cart"
        case .instacart: return "Shop \(name) list on Instacart"
        case .share: return "Share \(name) list"
        }
    }

    private func send(storeId: String, storeName: String) async {
        busyStore = storeId
        defer { busyStore = nil }
        do {
            switch SendToCart.route(forStoreId: storeId) {
            case .instacart:
                let url = try await SendToCart.instacartLink(planId: plan.id, storeId: storeId)
                openURL(url)
            case .share:
                return // handled by ShareLink
            case .walmart:
                let link = SendToCart.walmartCartLink(items: items(at: storeId))
                guard let url = link.url else {
                    message = ("Add these on Walmart", "Only sale items can go straight into the Walmart cart, and this list has none. Search walmart.com for: \(link.notAdded.joined(separator: ", ")).")
                    return
                }
                if link.notAdded.isEmpty {
                    openURL(url)
                } else {
                    walmartLink = (url, "Adds \(link.added.count) sale item\(link.added.count == 1 ? "" : "s") to your Walmart cart. Add these yourself: \(link.notAdded.joined(separator: ", ")).")
                }
            case .kroger(let locationId):
                let result = try await SendToCart.addToKrogerCart(items: items(at: storeId), locationId: locationId)
                var body = "Added \(result.added.count) item\(result.added.count == 1 ? "" : "s") to your Kroger cart for pickup. Open the Kroger app to check out."
                if !result.notFound.isEmpty {
                    body += "\n\nCouldn't find: \(result.notFound.joined(separator: ", ")). Add \(result.notFound.count == 1 ? "it" : "them") yourself."
                }
                message = (result.added.isEmpty ? "Nothing added" : "In your cart", body)
            }
        } catch SendToCart.CartError.notConnected {
            needsKrogerSignIn = storeId
        } catch {
            message = ("Couldn't send the list", error.localizedDescription)
        }
    }

    private func connectThenSend(storeId: String) async {
        do {
            try await SendToCart.connectKroger()
        } catch SendToCart.CartError.cancelled {
            return
        } catch {
            message = ("Couldn't connect Kroger", error.localizedDescription)
            return
        }
        await send(storeId: storeId, storeName: "")
    }
}
