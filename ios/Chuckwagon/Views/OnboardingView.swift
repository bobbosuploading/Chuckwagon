import SwiftUI

/// First launch: household, diet and stores. Everything can be changed later in Settings.
struct OnboardingView: View {
    @Environment(Preferences.self) private var prefs

    var body: some View {
        NavigationStack {
            PreferencesForm(showsStores: true)
                .navigationTitle("Welcome to Chuckwagon")
                .safeAreaInset(edge: .bottom) {
                    Button {
                        prefs.hasOnboarded = true
                    } label: {
                        Text("Start saving")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding()
                    .background(.bar)
                    .disabled(prefs.favoriteStoreIds.isEmpty)
                }
        }
    }
}

/// Shared by onboarding and Settings.
struct PreferencesForm: View {
    @Environment(Preferences.self) private var prefs
    var showsStores: Bool
    @State private var stores: [Store] = []
    @State private var loadError: String?

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            if showsStores {
                Section {
                    if stores.isEmpty && loadError == nil {
                        ProgressView()
                    }
                    if let loadError {
                        Text(loadError).foregroundStyle(.secondary)
                    }
                    ForEach(stores) { store in
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
                    Text("H-E-B and more stores are coming.")
                }
            }

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
        .task {
            guard showsStores else { return }
            do { stores = try await Backend.stores() } catch { loadError = error.localizedDescription }
        }
    }
}
