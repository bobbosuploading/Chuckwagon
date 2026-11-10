import SwiftUI

/// Confirms the trip, asks what's already at home, then shows the plan.
struct HeadedToView: View {
    let store: Store
    @Environment(Preferences.self) private var prefs
    @Environment(\.dismiss) private var dismiss
    @State private var haveAtHome = ""
    @State private var premium = false
    @State private var planning = false
    @State private var plan: MealPlan?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let plan {
                    PlanView(plan: plan)
                } else if planning {
                    VStack(spacing: 18) {
                        Image(systemName: "frying.pan.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(Theme.red)
                            .symbolEffect(.bounce, options: .repeating)
                        Text("Rustling up supper…")
                            .font(Theme.title(24))
                            .foregroundStyle(Theme.ink)
                        Text("Matching this week's deals to meals your family will like.")
                            .font(Theme.body(.subheadline))
                            .foregroundStyle(Theme.ink.opacity(0.6))
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 40)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.cream.ignoresSafeArea())
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
        defer { planning = false }
        do {
            plan = try await Backend.planMeals(storeId: storeId, prefs: prefs, haveAtHome: haveAtHome, premium: premium)
        } catch {
            self.error = error.localizedDescription
        }
    }
}
