import SwiftUI

/// Confirms the trip, asks what's already at home, then shows the plan.
struct HeadedToView: View {
    let store: Store
    /// Other stores the shopper could also stop at.
    var otherStores: [Store] = []
    @State private var alsoAt: Set<String> = []
    @Environment(Preferences.self) private var prefs
    @Environment(\.dismiss) private var dismiss
    @State private var haveAtHome = ""
    @State private var premium = false
    @State private var planning = false
    @State private var plan: MealPlan?
    /// What the planner has done so far, while planning.
    @State private var progress: PlanProgress?
    @State private var error: String?

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
            .navigationTitle(plan == nil ? "Headed to \(store.chain.capitalized)" : "Your plan")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }

    private var form: some View {
        @Bindable var prefs = prefs
        return Form {
            Section {
                LabeledContent("Store", value: store.name)
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
            if !otherStores.isEmpty {
                Section {
                    ForEach(otherStores) { other in
                        let id = other.id ?? ""
                        Toggle(other.name, isOn: Binding(
                            get: { alsoAt.contains(id) },
                            set: { on in if on { alsoAt.insert(id) } else { alsoAt.remove(id) } }
                        ))
                    }
                } header: {
                    Text("Also stop at")
                } footer: {
                    Text("We'll buy each item where it's cheapest and split your list by store.")
                }
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
            .padding(.horizontal, 20)
            .padding(.bottom, 8)
        }
    }

    private func makePlan() async {
        guard let storeId = store.id else { return }
        planning = true
        error = nil
        progress = nil
        defer { planning = false }
        do {
            plan = try await Backend.planMeals(storeId: storeId, alsoStoreIds: Array(alsoAt), prefs: prefs, haveAtHome: haveAtHome, premium: premium,
                                              onProgress: { progress = $0 })
        } catch {
            self.error = Backend.friendlyMessage(for: error, planning: true)
        }
    }
}
