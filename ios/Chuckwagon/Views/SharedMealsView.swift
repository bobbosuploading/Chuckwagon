import SwiftUI
import UIKit

/// The share button on a plan (meal = nil) or a single meal. The backend makes a link that
/// opens it in the other person's Chuckwagon app, or a web page if they don't have the app.
struct MealSharing: ViewModifier {
    let planId: String?
    let meal: String?
    @State private var link: ShareLinks.Link?
    @State private var working = false
    @State private var error: String?

    func body(content: Content) -> some View {
        content
            .toolbar {
                if planId != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            share()
                        } label: {
                            if working {
                                ProgressView()
                            } else {
                                Image(systemName: "square.and.arrow.up")
                            }
                        }
                        .disabled(working)
                        .accessibilityLabel(meal == nil ? "Share this plan" : "Share this meal")
                    }
                }
            }
            .sheet(item: $link) { link in
                ActivityView(items: [link.message, link.url])
                    .presentationDetents([.medium, .large])
            }
            .alert("Couldn't share", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(error ?? "")
            }
    }

    private func share() {
        guard let planId, !working else { return }
        working = true
        Task {
            do {
                link = try await Backend.shareLink(planId: planId, meal: meal)
            } catch {
                self.error = Backend.friendlyMessage(for: error)
            }
            working = false
        }
    }
}

extension View {
    /// Adds a share button for a whole plan (meal nil) or one of its meals. Nothing shows when planId is nil.
    func mealSharing(planId: String?, meal: String?) -> some View {
        modifier(MealSharing(planId: planId, meal: meal))
    }
}

/// The iOS share sheet (Messages, Mail, AirDrop, Copy).
struct ActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Opened from a shared link: the meal or plan someone sent, in its own sheet.
struct SharedMealsView: View {
    let id: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            SharedMealsScreen(id: id)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                }
        }
    }
}

/// A shared meal or plan, loaded by its id. Used in the link sheet and under My plans.
struct SharedMealsScreen: View {
    let id: String
    @State private var shared: SharedMeals?
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if let shared {
                if !shared.isPlan, let meal = shared.meals.first {
                    MealDetailView(meal: meal, sharedFrom: shared.storeName)
                } else {
                    planList(shared)
                }
            } else {
                ContentUnavailableView("Couldn't open this", systemImage: "fork.knife",
                                       description: Text(error ?? "This shared meal wasn't found. The link may be incomplete."))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.cream.ignoresSafeArea())
        .navigationTitle(shared.map { $0.isPlan ? "Shared plan" : $0.title } ?? "Shared meal")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Pass it along: the same link works for anyone.
            if shared != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: ShareLinks.url(for: id)) { Image(systemName: "square.and.arrow.up") }
                }
            }
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            shared = try await Backend.sharedMeals(id: id)
            if let shared { SharedInbox.save(id: id, shared: shared) }
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }

    private func planList(_ shared: SharedMeals) -> some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(shared.title).font(Theme.title(22)).foregroundStyle(Theme.ink)
                    Text("Someone shared this plan with you. Sale prices were at \(shared.storeName) that week.")
                        .font(Theme.body(.caption))
                        .foregroundStyle(Theme.ink.opacity(0.6))
                    if let total = shared.totals?.estimatedTotal {
                        Text("About \(total.dollars) in all when it was shared")
                            .font(Theme.body(.caption, weight: .bold))
                            .foregroundStyle(Theme.ink.opacity(0.75))
                    }
                }
                .padding(.vertical, 4)
            }
            Section("Meals") {
                ForEach(shared.meals) { meal in
                    NavigationLink {
                        MealDetailView(meal: meal, sharedFrom: shared.storeName)
                    } label: {
                        MealSummary(meal: meal)
                    }
                }
            }
            if let list = shared.groceryList, !list.isEmpty {
                Section("Grocery list") {
                    ForEach(list) { li in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(li.item)
                                Text(li.quantityNote).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if li.onSale, let sale = li.salePrice {
                                Text(sale.dollars).font(.subheadline.bold())
                            } else if let total = li.lineTotal {
                                Text(total.dollars).font(.subheadline).foregroundStyle(Theme.ink.opacity(0.75))
                            }
                        }
                    }
                }
            }
        }
        .creamBackground()
    }
}

/// Meals and plans people shared with you, under My plans.
struct SharedWithYouRow: View {
    let item: SharedInbox.Item

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(Theme.title(17)).foregroundStyle(Theme.ink).lineLimit(2)
            Text("\(item.kind == "plan" ? "Plan" : "Meal") · \(item.storeName) · opened \(item.openedAt.formatted(.dateTime.month().day()))")
                .font(Theme.body(.caption))
                .foregroundStyle(Theme.ink.opacity(0.5))
        }
        .padding(.vertical, 4)
    }
}
