import SwiftUI

/// Picks saved meals to build a new plan around. Opens from "Meals to include" on the plan screen.
/// Keepers (meals the shopper liked) come first. Past meals (from the shopper's plans and meals
/// shared with them) show when searching or after "Show all past meals". Meals fed to the dogs
/// (disliked) never show.
struct SavedMealPicker: View {
    @Binding var selection: [MealPlan.Meal]
    /// No more than the number of meals in the plan.
    let max: Int

    @Environment(MealRatings.self) private var ratings
    @State private var mine: [MealPlan.Meal] = []
    @State private var shared: [MealPlan.Meal] = []
    @State private var loading = true
    @State private var error: String?
    @State private var search = ""
    @State private var showAll = false
    @State private var rateError: String?

    private typealias W = MealRatingWords

    private func matches(_ meal: MealPlan.Meal) -> Bool {
        search.isEmpty || meal.name.localizedCaseInsensitiveContains(search)
    }

    /// Keepers, newest first.
    private var keepers: [MealPlan.Meal] { ratings.liked.reversed() }

    /// A past meal that isn't a Keeper (those are listed above) and wasn't fed to the dogs.
    private func isPlainPast(_ meal: MealPlan.Meal) -> Bool {
        !ratings.isLiked(meal.name) && !ratings.isDisliked(meal.name)
    }

    private var pastShared: [MealPlan.Meal] { shared.filter(isPlainPast) }
    private var pastMine: [MealPlan.Meal] { mine.filter(isPlainPast) }
    private var pastCount: Int { pastShared.count + pastMine.count }
    private var hiddenCount: Int { (shared + mine).filter { ratings.isDisliked($0.name) }.count }

    /// Past meals show while searching, when the toggle is on, or when there are no Keepers yet.
    private var showsPast: Bool { !search.isEmpty || showAll || keepers.isEmpty }

    var body: some View {
        List {
            Section {
                Text(selection.count >= max
                     ? "That's \(max) of \(max) meals. Uncheck one to pick another, or add meals on the plan screen."
                     : "Pick up to \(max). We'll use your recipe and buy its ingredients on sale where we can, then plan the other meals around it.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            }

            keepersSection

            if !keepers.isEmpty && search.isEmpty {
                Section {
                    Toggle(isOn: $showAll) {
                        Label(loading ? "Show all past meals" : "Show all past meals (\(pastCount))",
                              systemImage: "clock.arrow.circlepath")
                    }
                    .tint(Theme.red)
                } footer: {
                    Text("Or search above to find any meal you've had.")
                }
            }

            if showsPast {
                if loading {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let error {
                    Text(error).font(Theme.body(.footnote)).foregroundStyle(.red)
                } else if keepers.isEmpty && pastCount == 0 {
                    Text("No saved meals yet. Meals from your plans, and meals people share with you, show up here.")
                        .font(Theme.body(.footnote))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                } else {
                    mealSection("Shared with you", pastShared.filter(matches))
                    mealSection(pastShared.isEmpty && keepers.isEmpty ? "" : "From your plans", pastMine.filter(matches), footer: pastFooter)
                    if !search.isEmpty && keepers.filter(matches).isEmpty && (pastShared + pastMine).filter(matches).isEmpty {
                        Text("No meals match \"\(search)\".")
                            .font(Theme.body(.footnote))
                            .foregroundStyle(Theme.ink.opacity(0.7))
                    }
                }
            }
        }
        .creamBackground()
        .searchable(text: $search, prompt: "Search all your meals")
        .navigationTitle("Saved meals")
        .navigationBarTitleDisplayMode(.inline)
        .alert("Couldn't save that", isPresented: Binding(get: { rateError != nil }, set: { if !$0 { rateError = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(rateError ?? "")
        }
        .task {
            await ratings.load()
            await load()
        }
    }

    @ViewBuilder private var keepersSection: some View {
        let shown = keepers.filter(matches)
        if !shown.isEmpty {
            Section {
                ForEach(shown) { meal in row(meal) }
            } header: {
                Label(W.likedList, systemImage: W.likeIcon)
                    .labelStyle(RatedLabelStyle(color: W.likeColor))
            }
        } else if keepers.isEmpty && search.isEmpty && ratings.loaded {
            Section {
                Text("Tip: swipe right on a meal you'd cook again to make it a \(W.like). \(W.likedList) show up here first, so you don't have to dig through every past meal.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.7))
            } header: {
                Label(W.likedList, systemImage: W.likeIcon)
                    .labelStyle(RatedLabelStyle(color: W.likeColor))
            }
        }
    }

    private var pastFooter: String? {
        hiddenCount > 0 ? "\(hiddenCount) meal\(hiddenCount == 1 ? "" : "s") you fed to the dogs \(hiddenCount == 1 ? "is" : "are") hidden." : nil
    }

    @ViewBuilder private func mealSection(_ title: String, _ meals: [MealPlan.Meal], footer: String? = nil) -> some View {
        if !meals.isEmpty {
            Section {
                ForEach(meals) { meal in row(meal) }
            } header: {
                if !title.isEmpty { Text(title) }
            } footer: {
                if let footer { Text(footer) }
            }
        }
    }

    private func isPicked(_ meal: MealPlan.Meal) -> Bool {
        selection.contains { MealRatings.key($0.name) == MealRatings.key(meal.name) }
    }

    private func row(_ meal: MealPlan.Meal) -> some View {
        let picked = isPicked(meal)
        let liked = ratings.isLiked(meal.name)
        return Button {
            if picked {
                selection.removeAll { MealRatings.key($0.name) == MealRatings.key(meal.name) }
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
                    MealNoteLine(name: meal.name, lines: 1)
                }
                Spacer()
                if ratings.saving == meal.name {
                    ProgressView()
                } else if liked {
                    Image(systemName: W.likeIcon)
                        .foregroundStyle(W.likeColor)
                        .accessibilityLabel("Liked")
                }
            }
        }
        .disabled(!picked && selection.count >= max)
        // Swipe right to make a meal a Keeper (or take it off), right from this list.
        .swipeActions(edge: .leading) {
            Button { rate(meal, !liked) } label: {
                Label(liked ? W.likeUndo : W.like, systemImage: liked ? W.likeUndoIcon : W.likeIcon)
            }
            .tint(liked ? Theme.ink.opacity(0.5) : W.likeColor)
            .accessibilityLabel(liked ? "Unlike" : "Like")
        }
    }

    private func rate(_ meal: MealPlan.Meal, _ liked: Bool) {
        Task { rateError = await ratings.setLiked(meal, liked) }
    }

    /// Meals from the shopper's plans (every idea, including the ones not picked) and from
    /// meals shared with them, newest first, each name once.
    private func load() async {
        defer { loading = false }
        var seen = Set<String>()
        func fresh(_ meals: [MealPlan.Meal]) -> [MealPlan.Meal] {
            meals.filter { seen.insert(MealRatings.key($0.name)).inserted }
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
