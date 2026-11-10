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
                    VStack(spacing: 16) {
                        ProgressView().controlSize(.large)
                        Text("Rustling up supper from this week's deals…")
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        Form {
            Section {
                LabeledContent("Store", value: store.name)
                LabeledContent("Meals", value: "\(prefs.mealCount) for \(prefs.householdSize) people")
                LabeledContent("Diet", value: prefs.diet)
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
            Section {
                Button {
                    Task { await makePlan() }
                } label: {
                    Text("Plan my meals").font(.headline).frame(maxWidth: .infinity)
                }
            }
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
