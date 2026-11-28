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
    @Environment(HouseholdList.self) private var household
    @Environment(\.dismiss) private var dismiss
    /// Picked stores, in the order they were picked. The first one is the main store.
    @State private var picked: [String] = []
    @State private var didPickDefaults = false
    @State private var haveAtHome = ""
    /// Saved meals to build the plan around.
    @State private var included: [MealPlan.Meal] = []
    /// What the shopper feels like eating this trip (not saved for next time).
    @State private var mood = MealMood()
    @State private var premium = false
    /// "Cook from what I have": on-hand items to use up (by id), others typed in, and the trip.
    @State private var cookFromHave = false
    @State private var useUpIds: Set<String> = []
    @State private var typedUseUp = ""
    @State private var storeTrip = "full"
    @State private var showAllOnHand = false
    /// The cheapest meals possible, for this trip only.
    @State private var cheapest = false
    @State private var planning = false
    @State private var plan: MealPlan?
    /// What the planner has done so far, while planning.
    @State private var progress: PlanProgress?
    @State private var error: String?
    @State private var showError = false

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
        // A plan that fails says why right away, not just in the form.
        .alert("Couldn't make your plan", isPresented: $showError) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(error ?? "")
        }
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
            // At the top, because the form comes back scrolled to the top after a failed plan.
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            cookFromHaveSection
            if !noTrip { storesSection }
            Section {
                Stepper("Meals: \(prefs.mealCount)", value: $prefs.mealCount, in: max(1, included.count)...7)
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
            planStyleSection
            if !noTrip {
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
            }
            if !cheapest {
                MealMoodSection(mood: $mood, mealCount: prefs.mealCount, includedNames: included.map(\.name))
            }
            includedSection
            Section {
                TextField("e.g. rice, eggs, onions", text: $haveAtHome, axis: .vertical)
            } header: {
                Text("Already have at home")
            } footer: {
                Text(household.onHand.isEmpty || !cookFromHave
                     ? "We'll leave these off your list. Salt, pepper, oil and basic spices are assumed."
                     : "We'll leave these off your list. Salt, pepper, oil and basic spices are assumed, and so is everything on your on-hand list.")
            }
            Section {
                Toggle("Chef's pick (premium meals)", isOn: $premium)
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
            .disabled(!canPlan)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
    }

    private var noTrip: Bool { cookFromHave && storeTrip == "none" }

    private var canPlan: Bool {
        if noTrip { return !useUpTexts.isEmpty || !household.onHand.isEmpty || !haveAtHome.trimmingCharacters(in: .whitespaces).isEmpty }
        return !picked.isEmpty
    }

    /// On-hand food, proteins first, then the rest by group.
    private var onHandSorted: [HouseholdList.OnHandItem] {
        household.onHand.sorted { a, b in
            func rank(_ i: HouseholdList.OnHandItem) -> Int {
                (i.useSoon ? 0 : 100) + (HouseholdList.onHandKinds.firstIndex(of: i.kind.isEmpty ? "Other" : i.kind) ?? 9)
            }
            return (rank(a), a.text.lowercased()) < (rank(b), b.text.lowercased())
        }
    }

    /// What has to be cooked: picked on-hand items and anything typed.
    private var useUpTexts: [String] {
        guard cookFromHave else { return [] }
        let picked = household.onHand.filter { useUpIds.contains($0.id) }.map(\.planText)
        let typed = typedUseUp.split(whereSeparator: { $0 == "," || $0 == "\n" })
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return Array((picked + typed).prefix(12))
    }

    private var cookFromHaveSection: some View {
        Section {
            Toggle("Cook from what I have", isOn: $cookFromHave.animation())
                .onChange(of: cookFromHave) { _, on in
                    if on, useUpIds.isEmpty {
                        useUpIds = Set(household.onHand.filter(\.useSoon).map(\.id))
                    }
                }
            if cookFromHave {
                let all = onHandSorted
                let shown = showAllOnHand ? all : Array(all.prefix(10))
                ForEach(shown) { item in
                    Button {
                        if useUpIds.contains(item.id) { useUpIds.remove(item.id) } else { useUpIds.insert(item.id) }
                    } label: {
                        HStack {
                            Image(systemName: useUpIds.contains(item.id) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(useUpIds.contains(item.id) ? Theme.sage : Theme.ink.opacity(0.35))
                            Text(item.planText).foregroundStyle(Theme.ink)
                            Spacer()
                            if item.useSoon {
                                Image(systemName: "flame.fill").foregroundStyle(Theme.red).font(.caption)
                            }
                        }
                    }
                    .buttonStyle(.borderless)
                }
                if all.count > shown.count {
                    Button("Show all \(all.count) on hand") { showAllOnHand = true }
                        .font(Theme.body(.footnote, weight: .semibold))
                }
                TextField("Anything else to use up, like 2 lb ground beef", text: $typedUseUp, axis: .vertical)
                NavigationLink {
                    OnHandView()
                } label: {
                    Label(household.onHand.isEmpty ? "Start your on-hand list" : "Edit on-hand list", systemImage: "refrigerator")
                }
                Picker("Store trip", selection: $storeTrip) {
                    Text("Full trip").tag("full")
                    Text("Few items").tag("minimal")
                    Text("No trip").tag("none")
                }
                .pickerStyle(.segmented)
            }
        } header: {
            Text("Use what's at home")
        } footer: {
            if !cookFromHave {
                Text("Pick proteins and other food that needs using up, and skip the store or grab just the few things missing.")
            } else {
                switch storeTrip {
                case "none":
                    Text("No store trip: meals use only what you have, plus salt, pepper, oil and basic spices. If there isn't enough for \(prefs.mealCount) meals, you'll get fewer.")
                case "minimal":
                    Text("A quick trip: we'll build meals around what you have and buy only the few things missing, on sale where we can.")
                default:
                    Text("Checked food goes into the meals first. The rest of your on-hand list stays off the grocery list, and we fill in from the sales.")
                }
            }
        }
    }

    private var planStyleSection: some View {
        @Bindable var prefs = prefs
        return Section {
            Toggle("Cheapest possible", isOn: $cheapest)
            Stepper(value: $prefs.longCooks, in: 0...min(2, prefs.mealCount)) {
                Text(prefs.longCooks == 0 ? "Long cooks: none" : "Long cooks: \(prefs.longCooks)")
            }
            if prefs.longCooks > 0 {
                Picker("Cooked on", selection: $prefs.longCookHow) {
                    Text("Smoker").tag("smoker")
                    Text("Slow cooker").tag("slow cooker")
                    Text("Either").tag("any")
                }
            }
        } header: {
            Text("Plan style")
        } footer: {
            Text(planStyleFooter)
        }
    }

    private var planStyleFooter: String {
        var parts: [String] = []
        if cheapest {
            parts.append("Cheapest possible: the lowest cost per meal, even if it's simple. Only your diet and allergies count; moods and dislikes are skipped.")
        }
        if prefs.longCooks > 0 {
            parts.append("Long cooks are low-and-slow meals like smoked ribs, smoked chicken, brisket or a slow-cooker roast. They take hours, so they're best on a weekend; the plan marks them.")
        } else if !cheapest {
            parts.append("Cheapest possible makes the lowest-cost meals. Long cooks add smoked ribs, chicken, brisket or a slow-cooker meal for the weekend.")
        }
        return parts.joined(separator: " ")
    }

    private var includedSection: some View {
        Section {
            ForEach(included) { meal in
                HStack {
                    Image(systemName: "fork.knife").foregroundStyle(Theme.red)
                    Text(meal.name)
                    Spacer()
                    Button {
                        included.removeAll { $0.name == meal.name }
                    } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.ink.opacity(0.35))
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Take \(meal.name) out")
                }
            }
            NavigationLink {
                SavedMealPicker(selection: $included, max: prefs.mealCount)
            } label: {
                Label(included.isEmpty ? "Pick saved meals" : "Change saved meals", systemImage: "book.closed")
            }
        } header: {
            Text("Meals to include")
        } footer: {
            Text(included.isEmpty
                 ? "Optional. Pick your \(MealRatingWords.likedList) or any past meal and we'll plan the rest around them, buying their ingredients on sale where we can."
                 : "\(included.count) of your \(prefs.mealCount) meals. We'll buy their ingredients on sale where we can and plan the other \(prefs.mealCount - included.count) around them.")
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
        guard canPlan else { return }
        let main = noTrip ? "" : (picked.first ?? "")
        if !noTrip { prefs.planStoreIds = picked }
        let useUp = useUpTexts
        let useUpKeys = Set(useUp.map(HouseholdList.key))
        let extras = Backend.PlanExtras(
            // The on-hand list goes to the planner only with "Cook from what I have" on. Otherwise
            // the planner builds meals around it, which the shopper didn't ask for.
            onHand: cookFromHave ? household.onHand.map(\.planText).filter { !useUpKeys.contains(HouseholdList.key($0)) } : [],
            useUp: useUp,
            storeTrip: cookFromHave ? storeTrip : "full",
            cheapest: cheapest,
            longCooks: min(prefs.longCooks, prefs.mealCount),
            longCookHow: prefs.longCookHow
        )
        planning = true
        error = nil
        progress = nil
        defer { planning = false }
        do {
            plan = try await Backend.planMeals(storeId: main, alsoStoreIds: noTrip ? [] : Array(picked.dropFirst()), prefs: prefs, haveAtHome: haveAtHome,
                                              premium: premium, includeMeals: included,
                                              theme: cheapest ? nil : mood.theme,
                                              nightThemes: cheapest ? nil : mood.nightThemes(mealCount: prefs.mealCount),
                                              options: extras,
                                              onProgress: { progress = $0 })
        } catch {
            self.error = Backend.friendlyMessage(for: error, planning: true)
            showError = true
        }
    }
}
