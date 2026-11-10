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

    private var myStores: [Store] {
        let favs = stores.filter { prefs.favoriteStoreIds.contains($0.id ?? "") }
        return favs.isEmpty ? stores : favs
    }

    private var currentStore: Store? { stores.first { $0.id == storeId } }

    private var visibleDeals: [Deal] {
        guard !search.isEmpty else { return deals }
        return deals.filter { $0.name.localizedCaseInsensitiveContains(search) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    categoryChips
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let error {
                    Text(error).foregroundStyle(.secondary)
                } else if visibleDeals.isEmpty {
                    ContentUnavailableView("No deals found", systemImage: "tag.slash")
                } else {
                    Section("\(visibleDeals.count) deals") {
                        ForEach(visibleDeals) { DealRow(deal: $0) }
                    }
                }
            }
            .searchable(text: $search, prompt: "Search deals")
            .navigationTitle(currentStore?.name ?? "Deals")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Store", selection: $storeId) {
                            ForEach(myStores) { Text($0.name).tag($0.id) }
                        }
                    } label: {
                        Label("Store", systemImage: "storefront")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showingSettings = true } label: { Image(systemName: "gearshape") }
                }
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    showingHeadedTo = true
                } label: {
                    Label("Headed to \(currentStore?.chain.capitalized ?? "the store")", systemImage: "cart")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(storeId == nil)
                .padding()
                .background(.bar)
            }
            .sheet(isPresented: $showingHeadedTo) {
                if let store = currentStore { HeadedToView(store: store) }
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

    private var categoryChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack {
                chip("All", symbol: "tag", selected: category == nil) { category = nil }
                ForEach(DealCategory.allCases) { c in
                    chip(c.label, symbol: c.symbol, selected: category == c) { category = c }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 4)
        }
    }

    private func chip(_ title: String, symbol: String, selected: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(.subheadline)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(selected ? Color.chuckRed : Color(.secondarySystemBackground), in: Capsule())
                .foregroundStyle(selected ? .white : .primary)
        }
        .buttonStyle(.plain)
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

struct DealRow: View {
    let deal: Deal

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: deal.imageUrl.flatMap(URL.init(string:))) { image in
                image.resizable().scaledToFit()
            } placeholder: {
                Color(.secondarySystemBackground)
            }
            .frame(width: 52, height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 8))

            VStack(alignment: .leading, spacing: 2) {
                Text(deal.name).font(.subheadline).lineLimit(2)
                if let size = deal.size { Text(size).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text(deal.salePrice.dollars + deal.perUnit).font(.subheadline.bold())
                Text(deal.regularPrice.dollars + deal.perUnit)
                    .font(.caption).strikethrough().foregroundStyle(.secondary)
                Text("\(deal.pctOff)% off").font(.caption2.bold()).foregroundStyle(Color.chuckRed)
            }
        }
    }
}
