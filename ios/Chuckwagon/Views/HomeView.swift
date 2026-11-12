import SwiftUI

/// This week's deals at one store, with the "Headed to" button. Opens from the store list
/// (StoresHomeView), which owns the navigation stack.
struct HomeView: View {
    @Environment(Preferences.self) private var prefs
    @Environment(\.scenePhase) private var scenePhase
    @State private var stores: [Store] = []
    @State private var storeId: String?
    @State private var category: DealCategory?
    @State private var stockUpOnly = false
    @State private var search = ""
    @State private var deals: [Deal] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showingHeadedTo = false
    @State private var showingPlans = false
    @State private var showingReceipt = false
    @State private var showingStockUpTrip = false
    @State private var selectedDeal: Deal?
    @State private var sharedDeals: [SharedDeal] = []
    @State private var showingShare = false
    /// A deal shared from another app, waiting to be finished (ShareInbox).
    @State private var inboxShare: InboxShare?

    struct InboxShare: Identifiable {
        var item: ShareInbox.Item
        var image: UIImage?
        var id: String { item.id }
    }

    init(storeId: String) {
        _storeId = State(initialValue: storeId)
    }

    /// Starred stores (or every nearby store if none are starred), plus the one being shown,
    /// which may be one the shopper tapped without starring.
    private var myStores: [Store] {
        let near = prefs.nearby(stores)
        let favs = near.filter { prefs.favoriteStoreIds.contains($0.id ?? "") }
        guard !favs.isEmpty else { return near }
        return near.filter { prefs.favoriteStoreIds.contains($0.id ?? "") || $0.id == storeId }
    }

    private var currentStore: Store? { stores.first { $0.id == storeId } }

    private var visibleShared: [SharedDeal] {
        guard !stockUpOnly else { return [] }
        var shown = sharedDeals
        if let category { shown = shown.filter { $0.category == category.rawValue } }
        if !search.isEmpty { shown = shown.filter { $0.name.localizedCaseInsensitiveContains(search) } }
        return shown
    }

    private var visibleDeals: [Deal] {
        var shown = stockUpOnly ? deals.filter { $0.stockUp != nil } : deals
        if !search.isEmpty { shown = shown.filter { $0.name.localizedCaseInsensitiveContains(search) } }
        return shown
    }

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                categoryChips
                content
            }
            .padding(.bottom, 100)
        }
        .background(Theme.cream.ignoresSafeArea())
        .searchable(text: $search, prompt: "Search this week's deals")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { showingPlans = true } label: { Label("My plans", systemImage: "list.bullet.clipboard") }
                Button { showingReceipt = true } label: { Label("Scan a receipt or ad", systemImage: "doc.text.viewfinder") }
                Button { showingStockUpTrip = true } label: { Label("Stock-up trip", systemImage: "shippingbox.fill") }
            }
        }
        .safeAreaInset(edge: .bottom) {
            Button {
                showingHeadedTo = true
            } label: {
                Label("Headed to \(currentStore?.chain.capitalized ?? "the store")", systemImage: "cart.fill")
            }
            .buttonStyle(BigButtonStyle())
            .disabled(storeId == nil)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
        .sheet(isPresented: $showingHeadedTo) {
            if let store = currentStore {
                HeadedToView(store: store, otherStores: myStores.filter { $0.id != store.id && $0.chain != store.chain })
            }
        }
        .sheet(item: $selectedDeal) { deal in
            DealDetailView(deal: deal, storeName: currentStore?.name)
        }
        .sheet(isPresented: $showingPlans) { MyPlansView() }
        .sheet(isPresented: $showingShare, onDismiss: { Task { await loadShared() } }) {
            ShareDealView(store: currentStore, myStores: myStores) { storeId = $0 }
        }
        .sheet(item: $inboxShare, onDismiss: { Task { await loadShared(); checkInbox() } }) { share in
            ShareDealView(store: currentStore, myStores: myStores, shared: (share.item, share.image)) { storeId = $0 }
        }
        .sheet(isPresented: $showingStockUpTrip) { StockUpTripView() }
        .sheet(isPresented: $showingReceipt, onDismiss: { Task { await loadStores(); await load() } }) {
            ReceiptScanView(store: currentStore, myStores: myStores) { added in
                // A store added from an ad photo: show it now, even if favorites would hide it.
                if !prefs.favoriteStoreIds.isEmpty, !prefs.favoriteStoreIds.contains(added) {
                    prefs.favoriteStoreIds.append(added)
                }
                storeId = added
            }
        }
        .task {
            do {
                try await Backend.signIn()
            } catch {
                self.error = error.localizedDescription
                return
            }
            await loadStores()
            checkInbox()
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                Task {
                    await loadStores()
                    checkInbox()
                }
            }
        }
        .task(id: "\(currentStore?.dealsStoreId ?? "")|\(category?.rawValue ?? "all")") { await load() }
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Opens a deal shared from another app, once the stores are loaded.
    private func checkInbox() {
        guard inboxShare == nil, !showingShare, !myStores.isEmpty, let next = ShareInbox.next() else { return }
        inboxShare = InboxShare(item: next.item, image: next.image)
    }

    /// Reload the store list. Runs on opening, after a scan and when the app comes back
    /// to the front, so stores added since launch (or a new ZIP, radius or favorites) show up.
    private func loadStores() async {
        await prefs.fillInCoordinatesIfMissing()
        do {
            stores = try await Backend.stores()
            error = nil
        } catch {
            self.error = error.localizedDescription
            return
        }
        // Keep the chosen store only if it is still one of the shopper's stores.
        if let id = storeId, !myStores.contains(where: { $0.id == id }) { storeId = nil }
        storeId = storeId ?? myStores.first?.id
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("THIS WEEK AT")
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(Theme.red)
                storeName
                if let line = currentStore?.cityLine, !line.isEmpty {
                    Label(line, systemImage: "mappin.and.ellipse")
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
                if let note = currentStore?.pricesNote {
                    Label(note, systemImage: "arrow.triangle.branch")
                        .font(Theme.body(.footnote))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
            }

            if !deals.isEmpty { savingsBanner }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
    }

    /// The store's name. With more than one store to pick from, tapping it switches stores.
    @ViewBuilder private var storeName: some View {
        let name = Text(currentStore?.name ?? "Your store")
            .font(Theme.title(30))
            .foregroundStyle(Theme.ink)
            .lineLimit(2)
            .minimumScaleFactor(0.7)
            .multilineTextAlignment(.leading)
        if myStores.count > 1 {
            Menu {
                Picker("Store", selection: $storeId) {
                    ForEach(myStores) { Text($0.name).tag($0.id) }
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    name
                    Image(systemName: "chevron.down.circle.fill")
                        .font(.title3)
                        .foregroundStyle(Theme.red)
                }
            }
            .accessibilityHint("Switches to another of your stores")
        } else {
            name
        }
    }

    private var savingsBanner: some View {
        let best = deals.map(\.pctOff).max() ?? 0
        return HStack(spacing: 14) {
            Image(systemName: "tag.fill")
                .font(.title2)
                .foregroundStyle(Theme.ink)
                .frame(width: 48, height: 48)
                .background(Theme.mustard, in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text("\(deals.count) deals on sale")
                    .font(Theme.body(.headline, weight: .bold))
                    .foregroundStyle(.white)
                // Ad deals like "Buy 2, get 1 free" have no percent off, so skip "Up to 0% off".
                Text((best > 0 ? "Up to \(best)% off. " : "") + "Tap \"Headed to\" and we'll plan supper around them.")
                    .font(Theme.body(.caption))
                    .foregroundStyle(.white.opacity(0.85))
            }
            Spacer(minLength: 0)
        }
        .padding(16)
        .background(
            LinearGradient(colors: [Theme.red, Theme.red.opacity(0.82)], startPoint: .topLeading, endPoint: .bottomTrailing),
            in: RoundedRectangle(cornerRadius: 20, style: .continuous)
        )
    }

    // MARK: Categories

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("All", symbol: "square.grid.2x2.fill", selected: category == nil && !stockUpOnly) {
                    category = nil
                    stockUpOnly = false
                }
                // One chip at a time: "Stock up" looks across every aisle, so it clears the aisle.
                chip("Stock up", symbol: "shippingbox.fill", selected: stockUpOnly) {
                    stockUpOnly = true
                    category = nil
                }
                ForEach(DealCategory.allCases) { c in
                    chip(c.label, symbol: c.symbol, selected: category == c && !stockUpOnly) {
                        category = c
                        stockUpOnly = false
                    }
                }
            }
            .padding(.horizontal, 20)
        }
    }

    private func chip(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(Theme.body(.subheadline, weight: .semibold))
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(selected ? Theme.ink : Theme.card, in: Capsule())
                .foregroundStyle(selected ? Theme.cream : Theme.ink)
                .shadow(color: Theme.ink.opacity(selected ? 0 : 0.08), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
    }

    // MARK: Deals

    @ViewBuilder private var content: some View {
        if !stockUpOnly && storeId != nil { sharedSection }
        if loading && deals.isEmpty {
            ProgressView().frame(maxWidth: .infinity).padding(.top, 60)
        } else if let error {
            Text(error)
                .font(Theme.body(.footnote))
                .foregroundStyle(Theme.ink.opacity(0.7))
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .card()
                .padding(.horizontal, 20)
        } else if visibleDeals.isEmpty {
            if stockUpOnly {
                ContentUnavailableView("No stock-up prices", systemImage: "shippingbox",
                                       description: Text("Nothing here is cheap enough to buy extra of right now. We flag items that are about 30% off or more and keep well."))
                    .padding(.top, 40)
            } else {
                ContentUnavailableView("No deals found", systemImage: "tag.slash")
                    .padding(.top, 40)
            }
        } else {
            if stockUpOnly {
                Label("\(visibleDeals.count) prices worth buying extra of, from every aisle. Tap STOCK UP on a deal for how much to buy and how to keep it.",
                      systemImage: "shippingbox.fill")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
                    .padding(.horizontal, 20)
            }
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(visibleDeals) { deal in
                    DealCard(deal: deal)
                        .contentShape(Rectangle())
                        .onTapGesture { selectedDeal = deal }
                        .accessibilityAddTraits(.isButton)
                        .accessibilityHint("Shows the full deal")
                }
            }
            .padding(.horizontal, 20)
        }
    }

    // MARK: Shared by shoppers

    @ViewBuilder private var sharedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Spotted by shoppers")
                    .font(Theme.body(.headline, weight: .bold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Button { showingShare = true } label: { Label("Share a deal", systemImage: "megaphone.fill") }
                    .font(Theme.body(.subheadline, weight: .semibold))
            }
            .padding(.horizontal, 20)
            if visibleShared.isEmpty {
                Text("Saw a grocery deal on Facebook, TikTok or Reddit? Tap Share a deal, or share the post to Chuckwagon from that app.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.65))
                    .padding(.horizontal, 20)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(alignment: .top, spacing: 12) {
                        ForEach(visibleShared) { deal in
                            SharedDealCard(deal: deal) { stillThere in Task { await vote(deal, stillThere: stillThere) } }
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 4)
                }
            }
        }
    }

    private func loadShared() async {
        guard let store = currentStore else { sharedDeals = []; return }
        sharedDeals = (try? await Backend.sharedDeals(store: store)) ?? []
    }

    private func vote(_ deal: SharedDeal, stillThere: Bool) async {
        guard let id = deal.id else { return }
        do {
            try await Backend.voteSharedDeal(id: id, stillThere: stillThere)
            await loadShared()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        // Stores in a price region show the deals of the store they share with.
        guard let storeId = currentStore?.dealsStoreId else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            deals = try await Backend.deals(storeId: storeId, category: category)
            await loadShared()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct DealCard: View {
    let deal: Deal

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ZStack(alignment: .topLeading) {
                AsyncImage(url: deal.imageUrl.flatMap(URL.init(string:))) { image in
                    image.resizable().scaledToFit()
                } placeholder: {
                    Image(systemName: "basket")
                        .font(.largeTitle)
                        .foregroundStyle(Theme.ink.opacity(0.2))
                }
                .frame(maxWidth: .infinity)
                .frame(height: 110)
                .padding(10)
                .background(Theme.cream.opacity(0.6), in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                if deal.pctOff > 0 {
                    SaleTag(pct: deal.pctOff).padding(6)
                } else if deal.promo != nil {
                    Text("DEAL")
                        .font(.system(size: 12, weight: .black, design: .rounded))
                        .foregroundStyle(Theme.ink)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Theme.mustard, in: Capsule())
                        .padding(6)
                }
            }

            Text(deal.name)
                .font(Theme.body(.subheadline, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(2, reservesSpace: true)
            if let size = deal.size {
                Text(size).font(Theme.body(.caption)).foregroundStyle(Theme.ink.opacity(0.55)).lineLimit(1)
            }

            if let sale = deal.salePrice {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(sale.dollars + deal.perUnit)
                        .font(.system(.title3, design: .rounded, weight: .heavy))
                        .foregroundStyle(Theme.red)
                    if let regular = deal.regularPrice {
                        Text(regular.dollars)
                            .font(Theme.body(.caption))
                            .strikethrough()
                            .foregroundStyle(Theme.ink.opacity(0.45))
                    }
                }
            }
            if let promo = deal.promo {
                Text(promo)
                    .font(Theme.body(.caption2, weight: .medium))
                    .foregroundStyle(Theme.red)
                    .lineLimit(3)
            }
            if let tip = deal.stockUp {
                StockUpBadge(tip: tip)
            }
            if deal.fromShopperPhoto {
                Label((deal.confirmations ?? 1) > 1 ? "From shoppers' ad photos" : "From a shopper's ad photo", systemImage: "camera")
                    .font(Theme.body(.caption2))
                    .foregroundStyle(Theme.ink.opacity(0.55))
            }
        }
        .padding(10)
        .card()
    }
}
