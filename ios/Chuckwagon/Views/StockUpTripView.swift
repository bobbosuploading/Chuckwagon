import SwiftUI

/// "Stock-up trip": bulk staples at Sam's Club and how their price per pound (or each)
/// compares with the grocery stores. Updated about once a month.
struct StockUpTripView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var list: ClubList?
    @State private var loading = true
    @State private var error: String?
    @State private var picked: Set<String> = []
    @State private var showAll = false

    private var shown: [ClubList.Item] {
        guard let list else { return [] }
        return showAll ? list.items : list.items.filter(\.worthIt)
    }

    private var sections: [(String, [ClubList.Item])] {
        let order = ["meat", "seafood", "dairy", "bakery", "frozen", "pantry"]
        return Dictionary(grouping: shown, by: \.category)
            .sorted { (order.firstIndex(of: $0.key) ?? 99) < (order.firstIndex(of: $1.key) ?? 99) }
            .map { ($0.key.capitalized, $0.value) }
    }

    private var shareText: String {
        let items = (list?.items ?? []).filter { picked.contains($0.id) }
        let lines = items.map { "☐ \($0.name) · \($0.price.dollars)" }
        let total = items.reduce(0) { $0 + $1.price }
        return (["Sam's Club stock-up list"] + lines + ["About \(total.dollars) total"]).joined(separator: "\n")
    }

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView()
                } else if let error {
                    ContentUnavailableView("Couldn't load the list", systemImage: "exclamationmark.triangle", description: Text(error))
                } else if list == nil || list?.items.isEmpty == true {
                    ContentUnavailableView("No stock-up list yet", systemImage: "shippingbox",
                                           description: Text("We check Sam's Club prices about once a month. Look again soon."))
                } else {
                    content
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.cream.ignoresSafeArea())
            .navigationTitle("Stock-up trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: shareText) { Label("Share list", systemImage: "square.and.arrow.up") }
                        .disabled(picked.isEmpty)
                }
            }
            .task { await load() }
        }
    }

    private var content: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sam's Club")
                        .font(Theme.title(24)).foregroundStyle(Theme.ink)
                    Text("Bulk staples that cost less per pound than your grocery stores. Worth one trip a month if you have room in the freezer and pantry.")
                        .font(Theme.body(.subheadline)).foregroundStyle(Theme.ink.opacity(0.75))
                    if let list {
                        Text("Website prices\(list.updatedDate.map { ", checked \($0.formatted(date: .abbreviated, time: .omitted))" } ?? ""). Your club's price can differ a little. Membership needed.")
                            .font(Theme.body(.caption)).foregroundStyle(Theme.ink.opacity(0.55))
                    }
                }
                .padding(.vertical, 4)
                Toggle("Show items that aren't cheaper too", isOn: $showAll)
                    .font(Theme.body(.subheadline))
                    .tint(Theme.sage)
            }

            if shown.isEmpty {
                Section {
                    Text("Nothing beats your grocery stores by 10% or more right now.")
                        .font(Theme.body(.subheadline)).foregroundStyle(Theme.ink.opacity(0.7))
                }
            }

            ForEach(sections, id: \.0) { title, items in
                Section(title) {
                    ForEach(items) { item in
                        ClubItemRow(item: item, picked: picked.contains(item.id)) {
                            if picked.contains(item.id) { picked.remove(item.id) } else { picked.insert(item.id) }
                        }
                    }
                }
            }

            if !picked.isEmpty {
                Section {
                    let total = (list?.items ?? []).filter { picked.contains($0.id) }.reduce(0) { $0 + $1.price }
                    Label("\(picked.count) picked, about \(total.dollars)", systemImage: "cart.fill")
                        .font(Theme.body(.subheadline, weight: .bold))
                        .foregroundStyle(Theme.ink)
                }
            }
        }
        .creamBackground()
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do { list = try await Backend.clubList() } catch { self.error = error.localizedDescription }
    }
}

private struct ClubItemRow: View {
    let item: ClubList.Item
    let picked: Bool
    let toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: picked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(picked ? Theme.sage : Theme.ink.opacity(0.35))
                    .font(.title3)
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.name)
                        .font(Theme.body(.subheadline, weight: .semibold))
                        .foregroundStyle(Theme.ink)
                    Text("\(item.price.dollars) · \(item.unitLabel(item.unitPrice))")
                        .font(Theme.body(.caption)).foregroundStyle(Theme.ink.opacity(0.7))
                    if let best = item.compare.first, let pct = item.pctCheaper {
                        Text(pct >= 1
                             ? "\(pct)% less than \(best.chain) (\(item.unitLabel(best.unitPrice)))"
                             : "\(best.chain) is the same or cheaper (\(item.unitLabel(best.unitPrice)))")
                            .font(Theme.body(.caption, weight: .bold))
                            .foregroundStyle(pct >= 10 ? Theme.sage : Theme.ink.opacity(0.55))
                    }
                    if let storage = item.storage, !storage.isEmpty {
                        Label(storage, systemImage: item.keepSymbol)
                            .font(.caption2).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
    }
}
