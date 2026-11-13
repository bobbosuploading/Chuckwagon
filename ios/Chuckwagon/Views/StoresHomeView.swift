import SwiftUI

/// The first screen: stores near the shopper, closest first. Starred stores ("My stores") sit on
/// top. Tap a store for this week's deals there; tap the star to keep it at the top.
/// A new shopper sees a welcome and sets their area right here, without going into Settings.
struct StoresHomeView: View {
    @Environment(Preferences.self) private var prefs
    @Environment(\.scenePhase) private var scenePhase
    @State private var stores: [Store] = []
    @State private var loading = true
    @State private var error: String?
    @State private var path: [String] = []
    /// Deal counts by the store whose deals a store shows (dealsStoreId). Missing = not counted yet.
    @State private var dealCounts: [String: Int] = [:]
    @State private var showingSettings = false
    @State private var showingPlans = false
    @State private var showingPlanTrip = false
    /// A deal shared from another app, waiting to be finished (ShareInbox).
    @State private var inboxShare: HomeView.InboxShare?

    /// Nearby stores, closest first (stores without a map position go last, by name).
    private var nearby: [Store] { prefs.nearbyClosestFirst(stores) }

    private var starred: [Store] { nearby.filter { prefs.favoriteStoreIds.contains($0.id ?? "") } }
    private var others: [Store] { nearby.filter { !prefs.favoriteStoreIds.contains($0.id ?? "") } }

    /// The stores the shopper uses for sharing: starred ones, or all nearby.
    private var myStores: [Store] { starred.isEmpty ? nearby : starred }

    private func dealCount(_ store: Store) -> Int? {
        store.dealsStoreId.flatMap { dealCounts[$0] }
    }

    /// For a store with no deals yet: the closest store of the same chain that has some.
    private func nearestWithDeals(like store: Store) -> Store? {
        nearby.first { $0.chain == store.chain && $0.id != store.id && (dealCount($0) ?? 0) > 0 }
    }

    private func distance(_ store: Store) -> Double? {
        guard prefs.latitude != 0 else { return nil }
        return store.distanceMiles(fromLat: prefs.latitude, lng: prefs.longitude)
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if prefs.zip.isEmpty {
                    welcome
                    AreaSection()
                } else {
                    areaRow
                    storeSections
                    householdRow
                }
            }
            .creamBackground()
            .font(Theme.body())
            .foregroundStyle(Theme.ink)
            .navigationTitle(prefs.zip.isEmpty ? "" : "Stores near you")
            .toolbar {
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button { showingPlans = true } label: { Label("My plans", systemImage: "list.bullet.clipboard") }
                    Button { showingSettings = true } label: { Label("Settings", systemImage: "slider.horizontal.3") }
                }
            }
            .refreshable { await loadStores() }
            .safeAreaInset(edge: .bottom) {
                if !prefs.zip.isEmpty, !nearby.isEmpty {
                    Button {
                        showingPlanTrip = true
                    } label: {
                        Label("Build a meal plan", systemImage: "cart.fill")
                    }
                    .buttonStyle(BigButtonStyle())
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                }
            }
            .navigationDestination(for: String.self) { id in
                HomeView(storeId: id)
            }
            .sheet(isPresented: $showingPlans, onDismiss: { checkInbox() }) { MyPlansView() }
            .sheet(isPresented: $showingPlanTrip, onDismiss: { checkInbox() }) { PlanTripView(stores: stores) }
            .sheet(isPresented: $showingSettings, onDismiss: { Task { await loadStores() } }) {
                NavigationStack {
                    PreferencesForm(showsStores: true)
                        .navigationTitle("Settings")
                        .toolbar { Button("Done") { showingSettings = false } }
                }
            }
            .sheet(item: $inboxShare, onDismiss: { checkInbox() }) { share in
                ShareDealView(store: nil, myStores: myStores, shared: (share.item, share.image)) { id in
                    path = [id]
                }
            }
            .task {
                do { try await Backend.signIn() } catch { self.error = error.localizedDescription }
                await loadStores()
            }
            // A new ZIP can bring stores we just started collecting; fetch again.
            .task(id: prefs.zip) {
                guard !prefs.zip.isEmpty else { return }
                await loadStores()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await loadStores() } }
            }
            .onChange(of: path) { _, now in
                if now.isEmpty { checkInbox() }
            }
        }
    }

    // MARK: Sections

    private var welcome: some View {
        Section {
            VStack(spacing: 10) {
                Image(systemName: "frying.pan.fill")
                    .font(.system(size: 38))
                    .foregroundStyle(.white)
                    .frame(width: 84, height: 84)
                    .background(Theme.red, in: Circle())
                    .overlay(Circle().stroke(Theme.mustard, lineWidth: 4))
                Text("Chuckwagon")
                    .font(Theme.title(34))
                    .foregroundStyle(Theme.ink)
                Text("Supper from this week's sales")
                    .font(Theme.body(.subheadline, weight: .medium))
                    .foregroundStyle(Theme.ink.opacity(0.65))
                Text("Tell us where you shop and we'll show the stores near you.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.65))
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .listRowBackground(Color.clear)
        }
    }

    private var areaRow: some View {
        Section {
            NavigationLink {
                AreaSettingsView()
            } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Near \(prefs.zip)")
                            .font(Theme.body(.body, weight: .semibold))
                        Text("Within \(prefs.storeRadius) miles")
                            .font(Theme.body(.caption))
                            .foregroundStyle(Theme.ink.opacity(0.6))
                    }
                } icon: {
                    Image(systemName: "mappin.and.ellipse").foregroundStyle(Theme.red)
                }
            }
        }
    }

    @ViewBuilder private var storeSections: some View {
        if loading && stores.isEmpty {
            Section { ProgressView().frame(maxWidth: .infinity) }
        } else if let error, stores.isEmpty {
            Section {
                Text(error).font(Theme.body(.footnote)).foregroundStyle(Theme.ink.opacity(0.7))
                Button("Try again") { Task { await loadStores() } }
            }
        } else if nearby.isEmpty {
            Section {
                Text("No stores near \(prefs.zip) yet. We're gathering deals for your area. Try a bigger distance, or check back after our next update (Monday, Wednesday or Friday morning).")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            }
        } else {
            if !starred.isEmpty {
                Section {
                    ForEach(starred) { storeRow($0) }
                } header: {
                    Text("My stores")
                }
            }
            Section {
                ForEach(others) { storeRow($0) }
            } header: {
                Text(starred.isEmpty ? "Pick a store" : "Other stores nearby")
            } footer: {
                Text(starred.isEmpty
                     ? "Tap a store to see this week's deals, or tap \"Build a meal plan\" to plan supper from one or more stores. Tap the star on the stores you shop at to keep them at the top."
                     : "Tap a store to see this week's deals. Some stores show prices from a nearby store of the same chain; it says so under the store.")
            }
        }
    }

    private func storeRow(_ store: Store) -> some View {
        let id = store.id ?? ""
        let isStarred = prefs.favoriteStoreIds.contains(id)
        return HStack(spacing: 12) {
            Button {
                if let i = prefs.favoriteStoreIds.firstIndex(of: id) {
                    prefs.favoriteStoreIds.remove(at: i)
                } else {
                    prefs.favoriteStoreIds.append(id)
                }
            } label: {
                Image(systemName: isStarred ? "star.fill" : "star")
                    .font(.title3)
                    .foregroundStyle(isStarred ? Theme.mustard : Theme.ink.opacity(0.35))
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(isStarred ? "Remove from my stores" : "Add to my stores")

            NavigationLink(value: id) {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(store.name)
                            .font(Theme.body(.body, weight: .semibold))
                            .foregroundStyle(Theme.ink)
                        if !store.cityLine.isEmpty {
                            Text(store.cityLine)
                                .font(Theme.body(.caption))
                                .foregroundStyle(Theme.ink.opacity(0.6))
                        }
                        if let note = store.pricesNote {
                            Text(note)
                                .font(Theme.body(.caption2))
                                .foregroundStyle(Theme.ink.opacity(0.55))
                        }
                        dealsLine(store)
                    }
                    Spacer(minLength: 8)
                    if let miles = distance(store) {
                        Text(miles < 10 ? String(format: "%.1f mi", miles) : "\(Int(miles.rounded())) mi")
                            .font(Theme.body(.caption, weight: .semibold))
                            .foregroundStyle(Theme.ink.opacity(0.55))
                    }
                }
            }
            .disabled(id.isEmpty)
        }
    }

    /// "142 deals this week", or "No deals yet" with the closest store of the chain that has some.
    @ViewBuilder private func dealsLine(_ store: Store) -> some View {
        if let count = dealCount(store) {
            if count > 0 {
                Label("\(count) \(count == 1 ? "deal" : "deals") this week", systemImage: "tag.fill")
                    .font(Theme.body(.caption, weight: .semibold))
                    .foregroundStyle(Theme.red)
            } else {
                let other = nearestWithDeals(like: store)
                let where_ = other.map { o in
                    distance(o).map { " Closest with deals: \(o.name), \(Int($0.rounded())) mi." } ?? " Closest with deals: \(o.name)."
                } ?? ""
                Text("No deals yet." + where_)
                    .font(Theme.body(.caption))
                    .foregroundStyle(Theme.ink.opacity(0.5))
            }
        }
    }

    private var householdRow: some View {
        Section {
            Button { showingSettings = true } label: {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("\(prefs.householdSize) \(prefs.householdSize == 1 ? "person" : "people"), \(prefs.mealCount) \(prefs.mealCount == 1 ? "meal" : "meals") per trip")
                            .foregroundStyle(Theme.ink)
                        Text(prefs.allergies.trimmingCharacters(in: .whitespaces).isEmpty
                             ? "No allergies set. Tap to add allergies, diet and foods you don't like."
                             : "Allergies: \(prefs.allergies)")
                            .font(Theme.body(.caption))
                            .foregroundStyle(Theme.ink.opacity(0.6))
                    }
                } icon: {
                    Image(systemName: "person.3.fill").foregroundStyle(Theme.red)
                }
            }
        } header: {
            Text("Your household")
        }
    }

    // MARK: Loading

    private func loadStores() async {
        await prefs.fillInCoordinatesIfMissing()
        do {
            stores = try await Backend.stores()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
        checkInbox()
        await loadDealCounts()
    }

    /// Counts deals for the nearby stores, one count per store whose deals are shown
    /// (stores in a price region share one). Counts in parallel; a failed count just shows nothing.
    private func loadDealCounts() async {
        let ids = Set(nearby.compactMap(\.dealsStoreId))
        let counts = await withTaskGroup(of: (String, Int?).self) { group in
            for id in ids {
                group.addTask { (id, try? await Backend.dealCount(storeId: id)) }
            }
            var found: [String: Int] = [:]
            for await (id, count) in group { if let count { found[id] = count } }
            return found
        }
        dealCounts.merge(counts) { _, new in new }
    }

    /// Opens a deal shared from another app, once the stores are loaded. Only while this list is
    /// showing with nothing on top of it; the deals screen checks the inbox itself.
    private func checkInbox() {
        guard inboxShare == nil, path.isEmpty, !showingSettings, !showingPlans, !showingPlanTrip, !myStores.isEmpty, let next = ShareInbox.next() else { return }
        inboxShare = HomeView.InboxShare(item: next.item, image: next.image)
    }
}

/// ZIP code, location and how far out to look for stores.
struct AreaSettingsView: View {
    @Environment(Preferences.self) private var prefs

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            AreaSection()
            Section {
                Picker("Show stores within", selection: $prefs.storeRadius) {
                    ForEach(Preferences.radiusChoices, id: \.self) { Text("\($0) miles").tag($0) }
                }
            }
        }
        .creamBackground()
        .font(Theme.body())
        .foregroundStyle(Theme.ink)
        .navigationTitle("Your area")
        .navigationBarTitleDisplayMode(.inline)
    }
}
