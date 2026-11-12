import SwiftUI

/// Settings. The store list is also on the first screen (StoresHomeView).
struct PreferencesForm: View {
    @Environment(Preferences.self) private var prefs
    var showsStores: Bool
    @State private var stores: [Store] = []
    @State private var loadError: String?

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            AreaSection()

            if showsStores {
                Section {
                    Picker("Show stores within", selection: $prefs.storeRadius) {
                        ForEach(Preferences.radiusChoices, id: \.self) { Text("\($0) miles").tag($0) }
                    }
                    if stores.isEmpty && loadError == nil {
                        ProgressView()
                    } else if !stores.isEmpty && prefs.nearby(stores).isEmpty {
                        Text("No stores near \(prefs.zip) yet. We're gathering deals for your area.")
                            .font(Theme.body(.footnote))
                            .foregroundStyle(Theme.ink.opacity(0.7))
                    }
                    if let loadError {
                        Text(loadError).foregroundStyle(.secondary)
                    }
                    ForEach(prefs.nearby(stores)) { store in
                        let id = store.id ?? ""
                        Button {
                            if let i = prefs.favoriteStoreIds.firstIndex(of: id) {
                                prefs.favoriteStoreIds.remove(at: i)
                            } else {
                                prefs.favoriteStoreIds.append(id)
                            }
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(store.name).foregroundStyle(.primary)
                                    Text(store.cityLine).font(.caption).foregroundStyle(.secondary)
                                    if let note = store.pricesNote {
                                        Text(note).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                if prefs.favoriteStoreIds.contains(id) {
                                    Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                                }
                            }
                        }
                    }
                } header: {
                    Text("Your stores")
                } footer: {
                    Text("Stores within about \(prefs.storeRadius) miles of your ZIP. Chains price by region, so some stores show prices from a nearby store of the same chain; it says so under the store. Walmart prices come from walmart.com for your area and can differ a little on the shelf.")
                }
            }

            AccountSection()

            Section("Household") {
                Stepper("People: \(prefs.householdSize)", value: $prefs.householdSize, in: 1...10)
                Stepper("Meals per trip: \(prefs.mealCount)", value: $prefs.mealCount, in: 1...7)
                Picker("Cooking time", selection: $prefs.maxCookMinutes) {
                    Text("Quick (30 min)").tag(30)
                    Text("Normal (45 min)").tag(45)
                    Text("I like to cook (90 min)").tag(90)
                }
            }

            Section {
                Picker("Diet", selection: $prefs.diet) {
                    ForEach(Preferences.diets, id: \.self) { Text($0) }
                }
                TextField("Allergies (e.g. peanuts, shellfish)", text: $prefs.allergies)
                TextField("Don't like (e.g. mushrooms, cilantro)", text: $prefs.dislikes)
            } header: {
                Text("Food")
            } footer: {
                Text("Allergies are never included in any meal.")
            }
        }
        .creamBackground()
        .font(Theme.body())
        .foregroundStyle(Theme.ink)
        .task {
            guard showsStores else { return }
            await prefs.fillInCoordinatesIfMissing()
            do { stores = try await Backend.stores() } catch { loadError = error.localizedDescription }
        }
    }
}
