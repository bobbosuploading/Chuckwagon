import SwiftUI

/// This week's deals at one store, with the "Headed to" button.
struct HomeView: View {
    @Environment(Preferences.self) private var prefs
    @State private var stores: [Store] = []
    @State private var storeId: String?
    @State private var category: DealCategory?
    @State private var search = ""
    @State private var deals: [Deal] = []
    @State private var loading = false
    @State private var error: String?
    @State private var showingHeadedTo = false
    @State private var showingSettings = false
    @State private var showingPlans = false
    @State private var showingReceipt = false

    private var myStores: [Store] {
        let near = prefs.nearby(stores)
        let favs = near.filter { prefs.favoriteStoreIds.contains($0.id ?? "") }
        return favs.isEmpty ? near : favs
    }

    private var currentStore: Store? { stores.first { $0.id == storeId } }

    private var visibleDeals: [Deal] {
        guard !search.isEmpty else { return deals }
        return deals.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    private let columns = [GridItem(.flexible(), spacing: 14), GridItem(.flexible(), spacing: 14)]

    var body: some View {
        NavigationStack {
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
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Store", selection: $storeId) {
                            ForEach(myStores) { Text($0.name).tag($0.id) }
                        }
                    } label: {
                        Label("Change store", systemImage: "storefront.fill")
                    }
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingPlans = true } label: { Label("My plans", systemImage: "list.bullet.clipboard") }
                    Button { showingReceipt = true } label: { Label("Scan a receipt", systemImage: "doc.text.viewfinder") }
                        .disabled(currentStore == nil)
                    Button { showingSettings = true } label: { Image(systemName: "slider.horizontal.3") }
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
            .sheet(isPresented: $showingPlans) { MyPlansView() }
            .sheet(isPresented: $showingReceipt) {
                if let store = currentStore { ReceiptScanView(store: store) }
            }
            .sheet(isPresented: $showingSettings) {
                NavigationStack {
                    PreferencesForm(showsStores: true)
                        .navigationTitle("Settings")
                        .toolbar { Button("Done") { showingSettings = false } }
                }
            }
            .task {
                do {
                    try await Backend.signIn()
                    stores = try await Backend.stores()
                    storeId = storeId ?? myStores.first?.id
                } catch {
                    self.error = error.localizedDescription
                }
            }
            .task(id: "\(storeId ?? "")|\(category?.rawValue ?? "all")") { await load() }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("THIS WEEK AT")
                    .font(.system(size: 13, weight: .heavy, design: .rounded))
                    .tracking(1.5)
                    .foregroundStyle(Theme.red)
                Text(currentStore?.name ?? "Your store")
                    .font(Theme.title(30))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                if let line = currentStore?.cityLine, !line.isEmpty {
                    Label(line, systemImage: "mappin.and.ellipse")
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
            }

            if !deals.isEmpty { savingsBanner }
        }
        .padding(.horizontal, 20)
        .padding(.top, 4)
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
                Text("Up to \(best)% off. Tap \"Headed to\" and we'll plan supper around them.")
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
                chip("All", symbol: "square.grid.2x2.fill", selected: category == nil) { category = nil }
                ForEach(DealCategory.allCases) { c in
                    chip(c.label, symbol: c.symbol, selected: category == c) { category = c }
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
            ContentUnavailableView("No deals found", systemImage: "tag.slash")
                .padding(.top, 40)
        } else {
            LazyVGrid(columns: columns, spacing: 14) {
                ForEach(visibleDeals) { DealCard(deal: $0) }
            }
            .padding(.horizontal, 20)
        }
    }

    private func load() async {
        guard let storeId else { return }
        loading = true
        error = nil
        defer { loading = false }
        do {
            deals = try await Backend.deals(storeId: storeId, category: category)
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
        }
        .padding(10)
        .card()
    }
}
