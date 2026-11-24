import SwiftUI

/// Settings > Meals you don't like: every meal marked "Don't like", with a way to undo each.
struct DislikedMealsView: View {
    @Environment(DislikedMeals.self) private var dislikedMeals
    @State private var error: String?

    var body: some View {
        List {
            if dislikedMeals.names.isEmpty {
                Section {
                    Text(dislikedMeals.loaded
                         ? "No meals yet. In a plan, swipe left on a meal (or open it) and tap Don't like, and new plans will stop suggesting it."
                         : "Loading…")
                        .font(Theme.body(.callout))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                }
            } else {
                Section {
                    // Newest first.
                    ForEach(dislikedMeals.names.reversed(), id: \.self) { name in
                        HStack {
                            Text(name)
                            Spacer()
                            if dislikedMeals.saving == name {
                                ProgressView()
                            } else {
                                Button("Undo") { undo(name) }
                                    .buttonStyle(.borderless)
                                    .disabled(dislikedMeals.saving != nil)
                            }
                        }
                        .swipeActions {
                            Button { undo(name) } label: { Label("Suggest again", systemImage: "hand.thumbsup") }
                                .tint(Theme.sage)
                        }
                    }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.red)
                    } else {
                        Text("New plans skip these meals and ones like them. Tap Undo to see a meal again. We keep your last \(DislikedMeals.maxCount).")
                    }
                }
            }
        }
        .creamBackground()
        .navigationTitle("Meals you don't like")
        .navigationBarTitleDisplayMode(.inline)
        .task { await dislikedMeals.load(force: true) }
    }

    private func undo(_ name: String) {
        Task { error = await dislikedMeals.set(name, disliked: false) }
    }
}
