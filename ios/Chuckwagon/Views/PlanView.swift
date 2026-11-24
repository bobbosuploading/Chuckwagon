import SwiftUI

/// The meal plan: meals on one tab, the checkable grocery list on the other.
struct PlanView: View {
    @State var plan: MealPlan
    @Environment(DislikedMeals.self) private var dislikedMeals
    @State private var tab = Tab.list
    /// True while the backend rebuilds the list for a new set of meals.
    @State private var choosing = false
    @State private var chooseError: String?

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
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Image(systemName: "storefront.fill").foregroundStyle(Theme.red)
                        Text(s.storeName).font(Theme.body(.subheadline, weight: .semibold))
                        Spacer()
                        Text("\(s.items) items · save \(s.savings.dollars)")
                            .font(Theme.body(.caption))
                            .foregroundStyle(Theme.ink.opacity(0.6))
                    }
                    if let note = s.pricesNote {
                        Text(note).font(Theme.body(.caption2)).foregroundStyle(Theme.ink.opacity(0.55))
                    }
                }
            }
        } else if let note = plan.stores?.first?.pricesNote {
            Label(note, systemImage: "arrow.triangle.branch")
                .font(Theme.body(.caption))
                .foregroundStyle(Theme.ink.opacity(0.6))
        }
    }

    var body: some View {
        List {
            Section {
                savingsHeader
                if let budget = plan.budget {
                    BudgetMeter(budget: budget, total: plan.totals.estimatedTotal ?? plan.totals.saleItems,
                                perServing: plan.totals.perServing, unpriced: plan.totals.itemsNotPriced)
                }
                Picker("View", selection: $tab) {
                    ForEach(Tab.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
            }

            switch tab {
            case .list:
                storeSummary
                if let options = plan.options, options.meals.count > plan.meals.count {
                    Button {
                        tab = .meals
                    } label: {
                        Label(extraIdeasText(options), systemImage: "arrow.triangle.swap")
                            .font(Theme.body(.subheadline, weight: .semibold))
                    }
                }
                SendToCartSection(plan: plan)
                ForEach(aisles, id: \.0) { aisle, indices in
                    Section(aisle) {
                        ForEach(indices, id: \.self) { i in
                            ListItemRow(item: $plan.groceryList[i])
                        }
                    }
                }
            case .meals:
                if let options = plan.options {
                    Section {
                        ForEach(options.meals) { meal in
                            MealPickRow(meal: meal, planId: plan.id, picked: options.chosen.contains(meal.name), busy: choosing,
                                        disliked: dislikedMeals.contains(meal.name)) {
                                toggle(meal.name)
                            }
                            .swipeActions { dislikeButton(meal) }
                            .contextMenu { dislikeButton(meal) }
                        }
                    } header: {
                        HStack {
                            Text("Pick your meals")
                            if choosing { Spacer(); ProgressView() }
                        }
                    } footer: {
                        Text("Tap a circle to add or drop a meal. The grocery list and total change to match. Swipe left on a meal you don't like so new plans stop suggesting it.")
                    }
                } else {
                    ForEach(plan.meals) { meal in
                        NavigationLink {
                            MealDetailView(meal: meal, planId: plan.id)
                        } label: {
                            MealSummary(meal: meal, disliked: dislikedMeals.contains(meal.name))
                        }
                        .swipeActions { dislikeButton(meal) }
                        .contextMenu { dislikeButton(meal) }
                    }
                }
            }

            if !plan.notes.isEmpty {
                Section("Notes") { Text(plan.notes).font(Theme.body(.callout)) }
            }
        }
        .creamBackground()
        // Share the plan (its picked meals and grocery list) by link.
        .mealSharing(planId: plan.id, meal: nil)
        .onChange(of: plan.groceryList.filter(\.checked).map(\.id)) { _, ids in
            Task { try? await Backend.saveChecked(planId: plan.id, itemIds: ids) }
        }
        .alert("Couldn't change meals", isPresented: Binding(get: { chooseError != nil }, set: { if !$0 { chooseError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(chooseError ?? "")
        }
    }

    private func extraIdeasText(_ options: MealPlan.Options) -> String {
        let spare = options.meals.count - plan.meals.count
        return "Not feeling a meal? \(spare) more idea\(spare == 1 ? "" : "s") on the Meals tab"
    }

    /// "Don't like" (or "Undo") for a meal: swipe left on it, or press and hold.
    @ViewBuilder private func dislikeButton(_ meal: MealPlan.Meal) -> some View {
        if dislikedMeals.contains(meal.name) {
            Button { setDisliked(meal.name, false) } label: {
                Label("Suggest again", systemImage: "hand.thumbsup")
            }
            .tint(Theme.sage)
        } else {
            Button(role: .destructive) { setDisliked(meal.name, true) } label: {
                Label("Don't like", systemImage: "hand.thumbsdown")
            }
        }
    }

    /// Saves a dislike (or undoes one). A disliked meal that's picked in this plan is swapped
    /// for a spare idea, or dropped when there's no spare and other meals are left.
    private func setDisliked(_ name: String, _ disliked: Bool) {
        Task {
            if let message = await dislikedMeals.set(name, disliked: disliked) {
                chooseError = message
                return
            }
            guard disliked, let options = plan.options, options.chosen.contains(name) else { return }
            var chosen = options.chosen.filter { $0 != name }
            if let spare = options.meals.first(where: { !options.chosen.contains($0.name) && !dislikedMeals.contains($0.name) }) {
                chosen.append(spare.name)
            }
            guard !chosen.isEmpty else { return }
            choose(chosen)
        }
    }

    /// Adds or drops a meal, then shows the list the backend rebuilt for the new picks.
    private func toggle(_ name: String) {
        guard let options = plan.options, !choosing else { return }
        var chosen = options.chosen
        if let i = chosen.firstIndex(of: name) {
            guard chosen.count > 1 else {
                chooseError = "Keep at least one meal. Pick another one first, then drop this one."
                return
            }
            chosen.remove(at: i)
        } else {
            chosen.append(name)
        }
        choose(chosen)
    }

    /// Sends the new picks and shows the list the backend rebuilt for them.
    private func choose(_ picks: [String]) {
        guard let options = plan.options, !choosing else { return }
        // Keep the planner's order so the meals don't jump around.
        let chosen = options.meals.map(\.name).filter { picks.contains($0) }
        choosing = true
        Task {
            do {
                plan = try await Backend.chooseMeals(planId: plan.id, meals: chosen)
            } catch {
                chooseError = error.localizedDescription
            }
            choosing = false
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
                Text("\(plan.meals.count) \(plan.meals.count == 1 ? "meal" : "meals")").font(Theme.body(.subheadline, weight: .bold)).foregroundStyle(.white)
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

/// "Budget $60 · about $54 · $6 left", with a bar that turns red when the list runs over.
struct BudgetMeter: View {
    let budget: MealPlan.Budget
    let total: Double
    var perServing: Double?
    var unpriced = 0

    private var fraction: Double { budget.amount > 0 ? min(total / budget.amount, 1) : 0 }
    private var tint: Color { budget.fits ? Theme.sage : Theme.red }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Label("Budget \(budget.amount.wholeDollars)", systemImage: "dollarsign.circle.fill")
                    .font(Theme.body(.subheadline, weight: .bold))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Text(budget.fits ? "\(budget.left.dollars) left" : "\((-budget.left).dollars) over")
                    .font(Theme.body(.subheadline, weight: .heavy))
                    .foregroundStyle(tint)
            }
            ProgressView(value: fraction)
                .tint(tint)
            HStack {
                Text("About \(total.dollars) for this list")
                if let perServing {
                    Text("·")
                    Text("\(perServing.dollars) a serving")
                }
            }
            .font(Theme.body(.caption))
            .foregroundStyle(Theme.ink.opacity(0.6))
            if unpriced > 0 {
                Text("\(unpriced) item\(unpriced == 1 ? " has" : "s have") no price yet, so leave a little room.")
                    .font(Theme.body(.caption2))
                    .foregroundStyle(Theme.ink.opacity(0.5))
            }
        }
        .padding(.vertical, 4)
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
                    if let tip = item.stockUp, !item.checked {
                        StockUpNote(tip: tip)
                    }
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
                        Text(item.priceSource == "estimate" ? "est. price" : item.priceSource == "nearby" ? "nearby price" : "regular")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }
}

/// "Chicken tacos · 30 min · serves 3 · 4 sale items".
struct MealSummary: View {
    let meal: MealPlan.Meal
    /// The shopper marked this meal "Don't like", so new plans skip it.
    var disliked = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(meal.name).font(Theme.title(18)).foregroundStyle(Theme.ink)
            Text("\(meal.timeMinutes) min · serves \(meal.servings) · \(meal.ingredients.filter(\.isOnSale).count) sale items")
                .font(.caption).foregroundStyle(.secondary)
            if disliked {
                Label("You don't like this. New plans skip it.", systemImage: "hand.thumbsdown.fill")
                    .font(.caption2.bold())
                    .foregroundStyle(Theme.red)
            }
        }
    }
}

/// A meal idea with a circle to pick or drop it. The rest of the row opens the recipe.
struct MealPickRow: View {
    let meal: MealPlan.Meal
    var planId: String?
    let picked: Bool
    let busy: Bool
    var disliked = false
    let onToggle: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onToggle) {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .font(.title2)
                    .foregroundStyle(picked ? Theme.sage : Theme.ink.opacity(0.35))
            }
            .buttonStyle(.borderless)
            .disabled(busy)
            .accessibilityLabel(picked ? "Drop \(meal.name)" : "Pick \(meal.name)")
            NavigationLink {
                MealDetailView(meal: meal, planId: planId)
            } label: {
                MealSummary(meal: meal, disliked: disliked)
                    .opacity(picked ? 1 : 0.6)
            }
        }
    }
}

struct MealDetailView: View {
    let meal: MealPlan.Meal
    /// The shopper's own plan, so the meal can be shared by link. Nil for meals someone shared.
    var planId: String? = nil
    /// For a meal someone shared: the store its sale prices were from.
    var sharedFrom: String? = nil
    @Environment(DislikedMeals.self) private var dislikedMeals
    @State private var dislikeError: String?

    private var disliked: Bool { dislikedMeals.contains(meal.name) }

    var body: some View {
        List {
            Section {
                Label("\(meal.timeMinutes) minutes", systemImage: "clock")
                Label("Serves \(meal.servings)", systemImage: "person.2")
            } footer: {
                if let sharedFrom {
                    Text("Shared with you from Chuckwagon. Items marked ON SALE were on sale at \(sharedFrom) that week.")
                }
            }
            Section("Ingredients") {
                ForEach(meal.ingredients, id: \.self) { ing in
                    HStack {
                        Text("\(ing.amount) \(ing.item)")
                        Spacer()
                        if ing.isOnSale {
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
            Section {
                Button {
                    Task { dislikeError = await dislikedMeals.set(meal.name, disliked: !disliked) }
                } label: {
                    HStack {
                        Label(disliked ? "Suggest this meal again" : "I don't like this meal",
                              systemImage: disliked ? "hand.thumbsup" : "hand.thumbsdown")
                        if dislikedMeals.saving == meal.name { Spacer(); ProgressView() }
                    }
                }
                .foregroundStyle(disliked ? Theme.sage : Theme.red)
                .disabled(dislikedMeals.saving != nil)
            } footer: {
                if let dislikeError {
                    Text(dislikeError).foregroundStyle(Theme.red)
                } else {
                    Text(disliked
                         ? "New plans won't suggest this meal or ones like it."
                         : "New plans will stop suggesting this meal and ones like it. You can undo this in Settings under Meals you don't like.")
                }
            }
        }
        .creamBackground()
        .mealSharing(planId: planId, meal: meal.name)
        .navigationTitle(meal.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}
