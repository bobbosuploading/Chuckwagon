import SwiftUI

/// The meal plan: meals on one tab, the checkable grocery list on the other.
struct PlanView: View {
    @State var plan: MealPlan
    @State private var tab = Tab.list

    enum Tab: String, CaseIterable { case list = "Grocery list", meals = "Meals" }

    private var aisles: [(String, [Int])] {
        let order = ["Produce", "Meat", "Seafood", "Dairy", "Bakery", "Frozen", "Pantry", "Other"]
        let grouped = Dictionary(grouping: plan.groceryList.indices) { plan.groceryList[$0].aisle }
        return grouped.sorted { (order.firstIndex(of: $0.key) ?? 99) < (order.firstIndex(of: $1.key) ?? 99) }
            .map { ($0.key, $0.value) }
    }

    var body: some View {
        List {
            Section {
                savingsHeader
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
            }

            switch tab {
            case .list:
                ForEach(aisles, id: \.0) { aisle, indices in
                    Section(aisle) {
                        ForEach(indices, id: \.self) { i in
                            ListItemRow(item: $plan.groceryList[i])
                        }
                    }
                }
            case .meals:
                ForEach(plan.meals) { meal in
                    NavigationLink {
                        MealDetailView(meal: meal)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(meal.name).font(.headline)
                            Text("\(meal.timeMinutes) min · serves \(meal.servings) · \(meal.ingredients.filter { $0.dealId != nil }.count) sale items")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if !plan.notes.isEmpty {
                Section("Notes") { Text(plan.notes).font(.callout) }
            }
        }
    }

    private var savingsHeader: some View {
        HStack {
            VStack(alignment: .leading) {
                Text("You save").font(.caption).foregroundStyle(.secondary)
                Text(plan.totals.savings.dollars).font(.title2.bold()).foregroundStyle(Color.chuckRed)
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text("Sale items").font(.caption).foregroundStyle(.secondary)
                Text(plan.totals.saleItems.dollars).font(.title3.bold())
            }
        }
    }
}

struct ListItemRow: View {
    @Binding var item: MealPlan.ListItem

    var body: some View {
        Button {
            item.checked.toggle()
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(item.checked ? Color.chuckRed : .secondary)
                    .font(.title3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.item).strikethrough(item.checked).foregroundStyle(item.checked ? .secondary : .primary)
                    Text(item.quantityNote).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if item.onSale, let sale = item.salePrice {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(sale.dollars).font(.subheadline.bold())
                        if let save = item.lineSavings, save > 0 {
                            Text("save \(save.dollars)").font(.caption2.bold()).foregroundStyle(Color.chuckRed)
                        }
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }
}

struct MealDetailView: View {
    let meal: MealPlan.Meal

    var body: some View {
        List {
            Section {
                Label("\(meal.timeMinutes) minutes", systemImage: "clock")
                Label("Serves \(meal.servings)", systemImage: "person.2")
            }
            Section("Ingredients") {
                ForEach(meal.ingredients, id: \.self) { ing in
                    HStack {
                        Text("\(ing.amount) \(ing.item)")
                        Spacer()
                        if ing.dealId != nil {
                            Text("ON SALE").font(.caption2.bold()).foregroundStyle(Color.chuckRed)
                        }
                    }
                }
            }
            Section("Steps") {
                ForEach(Array(meal.steps.enumerated()), id: \.offset) { i, step in
                    HStack(alignment: .top) {
                        Text("\(i + 1).").bold()
                        Text(step)
                    }
                }
            }
        }
        .navigationTitle(meal.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
