import SwiftUI

/// Every plan this user has made, newest first. Check marks are kept.
struct MyPlansView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var plans: [MealPlan] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load your plans", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if plans.isEmpty {
                    ContentUnavailableView("No plans yet", systemImage: "list.bullet.clipboard",
                                           description: Text("Tap \"Headed to\" to make your first one. It will be saved here."))
                } else {
                    List {
                        ForEach(plans) { plan in
                            NavigationLink {
                                PlanView(plan: plan)
                                    .navigationTitle(plan.storeName)
                                    .navigationBarTitleDisplayMode(.inline)
                            } label: {
                                PlanRow(plan: plan)
                            }
                        }
                        .onDelete(perform: delete)
                    }
                    .creamBackground()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.cream.ignoresSafeArea())
            .navigationTitle("My plans")
            .toolbar { Button("Done") { dismiss() } }
            .task { await load() }
        }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { plans = try await Backend.myPlans() } catch { self.error = error.localizedDescription }
    }

    private func delete(at offsets: IndexSet) {
        let ids = offsets.map { plans[$0].id }
        plans.remove(atOffsets: offsets)
        Task { for id in ids { try? await Backend.deletePlan(id: id) } }
    }
}

private struct PlanRow: View {
    let plan: MealPlan

    private var progress: String {
        let done = plan.groceryList.filter(\.checked).count
        return "\(done)/\(plan.groceryList.count) items"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(plan.createdDate?.formatted(.dateTime.weekday(.wide).month().day()) ?? "Plan")
                    .font(Theme.title(17))
                    .foregroundStyle(Theme.ink)
                Spacer()
                Text("save \(plan.totals.savings.dollars)")
                    .font(Theme.body(.caption, weight: .bold))
                    .foregroundStyle(Theme.red)
            }
            Text(plan.meals.map(\.name).joined(separator: " · "))
                .font(Theme.body(.subheadline))
                .foregroundStyle(Theme.ink.opacity(0.75))
                .lineLimit(2)
            Text("\(plan.storeName) · \(progress)")
                .font(Theme.body(.caption))
                .foregroundStyle(Theme.ink.opacity(0.5))
        }
        .padding(.vertical, 4)
    }
}
