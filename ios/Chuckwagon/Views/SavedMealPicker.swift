import SwiftUI

/// Picks saved meals (from the shopper's plans and meals shared with them) to build a new plan
/// around. Opens from "Meals to include" on the plan screen.
struct SavedMealPicker: View {
    @Binding var selection: [MealPlan.Meal]
    /// No more than the number of meals in the plan.
    let max: Int

    @State private var mine: [MealPlan.Meal] = []
    @State private var shared: [MealPlan.Meal] = []
    @State private var loading = true
    @State private var error: String?
    @State private var search = ""

    private func matches(_ meal: MealPlan.Meal) -> Bool {
        search.isEmpty || meal.name.localizedCaseInsensitiveContains(search)
    }

    var body: some View {
        List {
            if loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error {
                Text(error).font(Theme.body(.footnote)).foregroundStyle(.red)
            } else if mine.isEmpty && shared.isEmpty {
                Text("No saved meals yet. Meals from your plans, and meals people share with you, show up here.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            } else {
                Section {
                    Text(selection.count >= max
                         ? "That's \(max) of \(max) meals. Uncheck one to pick another, or add meals on the plan screen."
                         : "Pick up to \(max). We'll use your recipe and buy its ingredients on sale where we can, then plan the other meals around it.")
                        .font(Theme.body(.footnote))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                }
                mealSection("Shared with you", shared.filter(matches))
                mealSection(shared.isEmpty ? "" : "From your plans", mine.filter(matches))
            }
        }
        .creamBackground()
        .searchable(text: $search, prompt: "Search saved meals")
        .navigationTitle("Saved meals")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    @ViewBuilder private func mealSection(_ title: String, _ meals: [MealPlan.Meal]) -> some View {
        if !meals.isEmpty {
            Section {
                ForEach(meals) { meal in row(meal) }
            } header: {
                if !title.isEmpty { Text(title) }
            }
        }
    }

    private func isPicked(_ meal: MealPlan.Meal) -> Bool {
        selection.contains { $0.name.caseInsensitiveCompare(meal.name) == .orderedSame }
    }

    private func row(_ meal: MealPlan.Meal) -> some View {
        let picked = isPicked(meal)
        return Button {
            if picked {
                selection.removeAll { $0.name.caseInsensitiveCompare(meal.name) == .orderedSame }
            } else if selection.count < max {
                selection.append(meal)
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(picked ? Theme.red : Theme.ink.opacity(0.35))
                VStack(alignment: .leading, spacing: 2) {
                    Text(meal.name)
                        .font(Theme.body(.body, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                    Text("\(meal.timeMinutes) min · \(meal.ingredients.count) ingredients")
                        .font(Theme.body(.caption))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
            }
        }
        .disabled(!picked && selection.count >= max)
    }

    /// Meals from the shopper's plans (every idea, including the ones not picked) and from
    /// meals shared with them, newest first, each name once.
    private func load() async {
        defer { loading = false }
        var seen = Set<String>()
        func fresh(_ meals: [MealPlan.Meal]) -> [MealPlan.Meal] {
            meals.filter { seen.insert($0.name.lowercased()).inserted }
        }
        // Shared ones are read one by one, so only the most recent few.
        let ids = SharedInbox.items().prefix(10).map(\.id)
        let sharedMeals = await withTaskGroup(of: (Int, [MealPlan.Meal]).self) { group in
            for (i, id) in ids.enumerated() {
                group.addTask { (i, (try? await Backend.sharedMeals(id: id))?.meals ?? []) }
            }
            var found: [(Int, [MealPlan.Meal])] = []
            for await result in group { found.append(result) }
            return found.sorted { $0.0 < $1.0 }.flatMap(\.1)
        }
        shared = fresh(sharedMeals)
        do {
            let plans = try await Backend.myPlans()
            mine = fresh(plans.flatMap { $0.options?.meals ?? $0.meals })
        } catch {
            if shared.isEmpty { self.error = Backend.friendlyMessage(for: error, planning: false) }
        }
    }
}
