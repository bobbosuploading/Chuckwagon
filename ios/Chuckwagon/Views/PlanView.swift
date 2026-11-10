import SwiftUI

/// The meal plan: meals on one tab, the checkable grocery list on the other.
struct PlanView: View {
    @State var plan: MealPlan
    @State private var tab = Tab.list

    enum Tab: String, CaseIterable { case list = "Grocery list", meals = "Meals" }

    /// Sections of the list: by aisle, or by store then aisle when the plan uses several stores.
    private var aisles: [(String, [Int])] {
        let order = ["Produce", "Meat", "Seafood", "Dairy", "Bakery", "Frozen", "Pantry", "Other"]
        let storeOrder = (plan.stores ?? []).map(\.storeName)
        let multi = storeOrder.count > 1
        func key(_ i: Int) -> String {
            let li = plan.groceryList[i]
            return multi ? "\(li.storeName ?? "Any store") · \(li.aisle)" : li.aisle
        }
        func rank(_ k: String) -> Int {
            let parts = k.components(separatedBy: " · ")
            let aisle = parts.last ?? k
            let store = multi ? (storeOrder.firstIndex(of: parts.first ?? "") ?? 9) : 0
            return store * 100 + (order.firstIndex(of: aisle) ?? 99)
        }
        let grouped = Dictionary(grouping: plan.groceryList.indices, by: key)
        return grouped.sorted { rank($0.key) < rank($1.key) }.map { ($0.key, $0.value) }
    }

    @ViewBuilder private var storeSummary: some View {
        if let stores = plan.stores, stores.count > 1 {
            ForEach(stores, id: \.storeId) { s in
                HStack {
                    Image(systemName: "storefront.fill").foregroundStyle(Theme.red)
                    Text(s.storeName).font(Theme.body(.subheadline, weight: .semibold))
                    Spacer()
                    Text("\(s.items) items · save \(s.savings.dollars)")
                        .font(Theme.body(.caption))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                }
            }
        }
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
                storeSummary
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
                            Text(meal.name).font(Theme.title(18)).foregroundStyle(Theme.ink)
                            Text("\(meal.timeMinutes) min · serves \(meal.servings) · \(meal.ingredients.filter { $0.dealId != nil }.count) sale items")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
            }

            if !plan.notes.isEmpty {
                Section("Notes") { Text(plan.notes).font(Theme.body(.callout)) }
            }
        }
        .creamBackground()
        .onChange(of: plan.groceryList.filter(\.checked).map(\.id)) { _, ids in
            Task { try? await Backend.saveChecked(planId: plan.id, itemIds: ids) }
        }
    }

    private var savingsHeader: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("YOU SAVE").font(.system(size: 12, weight: .heavy, design: .rounded)).tracking(1.2)
                    .foregroundStyle(.white.opacity(0.85))
                Text(plan.totals.savings.dollars).font(Theme.title(34)).foregroundStyle(.white)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                Text("\(plan.meals.count) meals").font(Theme.body(.subheadline, weight: .bold)).foregroundStyle(.white)
                if let total = plan.totals.estimatedTotal, total > plan.totals.saleItems {
                    Text("About \(total.dollars) total").font(Theme.body(.caption, weight: .bold)).foregroundStyle(.white)
                }
                Text("Sale items \(plan.totals.saleItems.dollars)").font(Theme.body(.caption)).foregroundStyle(.white.opacity(0.85))
            }
        }
        .padding(18)
        .background(Theme.red, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
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
                    .foregroundStyle(item.checked ? Theme.sage : Theme.ink.opacity(0.35))
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
                } else if let total = item.lineTotal {
                    // Not on sale: everyday price from the store's price book or a receipt.
                    VStack(alignment: .trailing, spacing: 2) {
                        Text(total.dollars).font(.subheadline).foregroundStyle(Theme.ink.opacity(0.75))
                        Text(item.priceSource == "estimate" ? "est. price" : "regular")
                            .font(.caption2).foregroundStyle(.secondary)
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
                            Text("ON SALE")
                                .font(.system(size: 10, weight: .black, design: .rounded))
                                .foregroundStyle(Theme.ink)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                                .background(Theme.mustard, in: Capsule())
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
        .creamBackground()
        .navigationTitle(meal.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
