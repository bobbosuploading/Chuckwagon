import SwiftUI

/// First launch: household, diet and stores. Everything can be changed later in Settings.
struct OnboardingView: View {
    @Environment(Preferences.self) private var prefs

    var body: some View {
        NavigationStack {
            PreferencesForm(showsStores: true, showsWelcome: true)
                .toolbar(.hidden, for: .navigationBar)
                .safeAreaInset(edge: .bottom) {
                    Button("Start saving") {
                        prefs.hasOnboarded = true
                    }
                    .buttonStyle(BigButtonStyle())
                    .padding(.horizontal, 20)
                    .padding(.bottom, 8)
                    .disabled(prefs.favoriteStoreIds.isEmpty)
                }
        }
    }
}

/// Shared by onboarding and Settings.
struct PreferencesForm: View {
    @Environment(Preferences.self) private var prefs
    var showsStores: Bool
    var showsWelcome = false
    @State private var stores: [Store] = []
    @State private var loadError: String?

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            if showsWelcome {
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
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .listRowBackground(Color.clear)
                }
            }
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
        .creamBackground()
        .font(Theme.body())
        .foregroundStyle(Theme.ink)
        .task {
            guard showsStores else { return }
            do { stores = try await Backend.stores() } catch { loadError = error.localizedDescription }
        }
    }
}
