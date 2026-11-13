import SwiftUI

/// "Build a meal plan": pick the stores to shop at, how many meals and the rest, then shows
/// the plan. Opens from the store list (nothing picked yet, so last time's stores) and from a
/// store's deals (that store picked).
struct PlanTripView: View {
    /// Every store loaded; the ones near the shopper are offered.
    let stores: [Store]
    /// The store to start with, when opened from that store's deals.
    var startWith: String?
    /// The planner looks at up to this many stores at once.
    static let maxStores = 3

    @Environment(Preferences.self) private var prefs
    @Environment(\.dismiss) private var dismiss
    /// Picked stores, in the order they were picked. The first one is the main store.
    @State private var picked: [String] = []
    @State private var didPickDefaults = false
    @State private var haveAtHome = ""
    @State private var premium = false
    @State private var planning = false
    @State private var plan: MealPlan?
    /// What the planner has done so far, while planning.
    @State private var progress: PlanProgress?
    @State private var error: String?

    private var nearby: [Store] { prefs.nearbyClosestFirst(stores) }

    /// Stores to pick from: starred ones (plus any already picked), or every nearby store when
    /// none are starred.
    private var choices: [Store] {
        let starred = nearby.filter { prefs.favoriteStoreIds.contains($0.id ?? "") }
        guard !starred.isEmpty else { return nearby }
        return nearby.filter { prefs.favoriteStoreIds.contains($0.id ?? "") || picked.contains($0.id ?? "") }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let plan {
                    PlanView(plan: plan)
                } else if planning {
                    PlanProgressView(progress: progress)
                } else {
                    form
                }
            }
            .navigationTitle(plan == nil ? "Build a meal plan" : "Your plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
        .onAppear(perform: pickDefaults)
    }

    /// Starts with the store it was opened from, else the stores used last time, else the
    /// closest starred store (or the closest store).
    private func pickDefaults() {
        guard !didPickDefaults else { return }
        didPickDefaults = true
        let nearIds = Set(nearby.compactMap(\.id))
        if let startWith {
            picked = [startWith]
            return
        }
        let last = prefs.planStoreIds.filter { nearIds.contains($0) }
        if !last.isEmpty {
            picked = Array(last.prefix(Self.maxStores))
        } else if let first = choices.first?.id {
            picked = [first]
        }
    }

    private var form: some View {
        @Bindable var prefs = prefs
        return Form {
            storesSection
            Section {
                Stepper("Meals: \(prefs.mealCount)", value: $prefs.mealCount, in: 1...7)
                Stepper("People: \(prefs.householdSize)", value: $prefs.householdSize, in: 1...10)
                Picker("Diet", selection: $prefs.diet) {
                    ForEach(Preferences.diets, id: \.self) { Text($0) }
                }
                Picker("Cooking time", selection: $prefs.maxCookMinutes) {
                    Text("Quick (30 min)").tag(30)
                    Text("Normal (45 min)").tag(45)
                    Text("I like to cook (90 min)").tag(90)
                }
            } header: {
                Text("This trip")
            } footer: {
                Text("Changes here are saved for next time too.")
            }
            Section {
                Toggle("Stick to a budget", isOn: Binding(
                    get: { prefs.weeklyBudget > 0 },
                    set: { prefs.weeklyBudget = $0 ? Preferences.defaultBudget : 0 }
                ))
                if prefs.weeklyBudget > 0 {
                    Stepper(value: $prefs.weeklyBudget, in: 20...500, step: 5) {
                        HStack {
                            Text("I have")
                            Spacer()
                            Text(Double(prefs.weeklyBudget).wholeDollars)
                                .font(Theme.body(.body, weight: .bold))
                                .foregroundStyle(Theme.red)
                        }
                    }
                }
            } header: {
                Text("Budget")
            } footer: {
                Text(prefs.weeklyBudget > 0
                     ? "We'll build the meals and the whole list to fit, sale and everyday items together."
                     : "Turn this on and we'll plan around what you have to spend this trip.")
            }
            Section {
                TextField("e.g. rice, eggs, onions", text: $haveAtHome, axis: .vertical)
            } header: {
                Text("Already have at home")
            } footer: {
                Text("We'll leave these off your list. Salt, pepper, oil and basic spices are assumed.")
            }
            Section {
                Toggle("Chef's pick (premium meals)", isOn: $premium)
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
        }
        .creamBackground()
        .safeAreaInset(edge: .bottom) {
            Button {
                Task { await makePlan() }
            } label: {
                Label("Plan my meals", systemImage: "sparkles")
            }
            .buttonStyle(BigButtonStyle())
            .disabled(picked.isEmpty)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
    }

    @ViewBuilder private var storesSection: some View {
        Section {
            if choices.isEmpty {
                Text("No stores near you yet. Set your ZIP code on the first screen, or check back after our next update.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            }
            ForEach(choices) { store in
                storeToggle(store)
            }
        } header: {
            Text("Shop at")
        } footer: {
            Text(storesFooter)
        }
    }

    private var storesFooter: String {
        var text = "Pick up to \(Self.maxStores). With more than one, we'll buy each item where it's cheapest and split your list by store."
        if !nearby.isEmpty, choices.count < nearby.count {
            text += " Only your starred stores are listed; star more on the first screen."
        }
        return text
    }

    private func storeToggle(_ store: Store) -> some View {
        let id = store.id ?? ""
        let isOn = picked.contains(id)
        return Toggle(isOn: Binding(
            get: { isOn },
            set: { on in
                if on {
                    if !picked.contains(id) { picked.append(id) }
                } else {
                    picked.removeAll { $0 == id }
                }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text(store.name)
                if let detail = detailLine(store) {
                    Text(detail)
                        .font(Theme.body(.caption))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
            }
        }
        .disabled(id.isEmpty || (!isOn && picked.count >= Self.maxStores))
    }

    /// "El Campo, TX · 1.2 mi"
    private func detailLine(_ store: Store) -> String? {
        var parts: [String] = []
        if !store.cityLine.isEmpty { parts.append(store.cityLine) }
        if prefs.latitude != 0, let miles = store.distanceMiles(fromLat: prefs.latitude, lng: prefs.longitude) {
            parts.append(miles < 10 ? String(format: "%.1f mi", miles) : "\(Int(miles.rounded())) mi")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func makePlan() async {
        guard let main = picked.first else { return }
        prefs.planStoreIds = picked
        planning = true
        error = nil
        progress = nil
        defer { planning = false }
        do {
            plan = try await Backend.planMeals(storeId: main, alsoStoreIds: Array(picked.dropFirst()), prefs: prefs, haveAtHome: haveAtHome,
                                              premium: premium, onProgress: { progress = $0 })
        } catch {
            self.error = Backend.friendlyMessage(for: error, planning: true)
        }
    }
}
