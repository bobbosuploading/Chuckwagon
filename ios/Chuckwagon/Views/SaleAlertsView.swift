import FirebaseFunctions
import SwiftUI

/// The sale-alert watch list. The backend checks it once a day (functions/src/saleWatch.ts).
enum SaleWatch {
    /// Ready-made items. The ids must match WATCH_ITEMS in functions/src/saleWatch.ts.
    static let items: [(id: String, label: String)] = [
        ("pork-belly", "Pork belly"),
        ("brisket", "Brisket"),
        ("pork-ribs", "Pork ribs"),
        ("beef-ribs", "Beef ribs"),
        ("pork-butt", "Pork butt (shoulder)"),
        ("chuck-roast", "Chuck roast"),
        ("ground-beef", "Ground beef"),
        ("bacon", "Bacon"),
        ("tri-tip", "Tri-tip"),
        ("whole-chicken", "Whole chicken"),
        ("chicken-thighs", "Chicken thighs"),
        ("pork-loin", "Pork loin"),
    ]
    static let pctChoices = [20, 25, 30, 40, 50]
    static let maxCustom = 10

    struct Hit: Identifiable {
        let id = UUID()
        let line: String
        let alert: Bool
    }

    /// "See what's on sale now": the watch list against this week's deals, right away.
    @MainActor
    static func checkNow(_ prefs: Preferences) async throws -> [Hit] {
        let storeIds = await PushNotifications.dealStoreIds(prefs)
        let result = try await Functions.functions().httpsCallable("checkSaleWatch").call([
            "storeIds": storeIds,
            "watch": prefs.watchPayload,
            "timeZone": TimeZone.current.identifier,
        ])
        let hits = ((result.data as? [String: Any])?["hits"] as? [[String: Any]]) ?? []
        return hits.compactMap { h in
            guard let line = h["line"] as? String else { return nil }
            return Hit(line: line, alert: h["alert"] as? Bool ?? false)
        }
    }
}

/// Settings > Notifications > Sale alerts.
struct SaleAlertsView: View {
    @Environment(Preferences.self) private var prefs
    @State private var newItem = ""
    @State private var blocked = false
    @State private var checking = false
    @State private var hits: [SaleWatch.Hit]?
    @State private var checkError: String?

    var body: some View {
        @Bindable var prefs = prefs
        Form {
            Section {
                Toggle("Homemade bacon", isOn: allowed($prefs.watchBacon))
                Toggle("Grind my own ground beef", isOn: allowed($prefs.watchGroundBeef))
                Toggle("Homemade beef jerky", isOn: allowed($prefs.watchJerky))
            } header: {
                Text("Make it yourself")
            } footer: {
                Text("We'll tell you when a cut on sale makes it cheaper to make your own than to buy it ready-made, after what you trim off and what cooks or dries away. Bacon uses pork belly. Ground beef picks the cheapest of chuck, brisket, sirloin and round roasts. Jerky uses round roasts, flank or sirloin tip, at about 2.7 lb of raw beef per lb of jerky.")
            }

            Section("Cuts to watch") {
                ForEach(SaleWatch.items, id: \.id) { item in
                    Toggle(item.label, isOn: allowed(Binding(
                        get: { prefs.watchItems.contains(item.id) },
                        set: { on in
                            if on { if !prefs.watchItems.contains(item.id) { prefs.watchItems.append(item.id) } }
                            else { prefs.watchItems.removeAll { $0 == item.id } }
                        }
                    )))
                }
            }

            Section {
                ForEach(prefs.watchCustom, id: \.self) { Text($0) }
                    .onDelete { prefs.watchCustom.remove(atOffsets: $0) }
                if prefs.watchCustom.count < SaleWatch.maxCustom {
                    HStack {
                        TextField("Add an item, like toilet paper", text: $newItem)
                            .submitLabel(.done)
                            .onSubmit(addItem)
                        Button("Add", action: addItem)
                            .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            } header: {
                Text("Your own items")
            } footer: {
                Text("Anything on sale whose name has all the words you type. Swipe left to remove one.")
            }

            Section {
                Picker("Alert me at", selection: $prefs.watchAlertPct) {
                    ForEach(SaleWatch.pctChoices, id: \.self) { Text("\($0)% or more").tag($0) }
                }
            } footer: {
                Text("How much a sale has to save, compared with the usual price (or with buying it ready-made), before we send an alert. H-E-B's weekly ad doesn't always show regular prices, so for H-E-B we compare with what the item has gone for there before, and that gets better each week.")
            }

            if blocked {
                Section {
                    Text("Notifications are turned off for Chuckwagon in iPhone Settings, so alerts can't reach you.")
                        .foregroundStyle(Theme.red)
                }
            }

            if prefs.wantsSaleAlerts {
                Section {
                    Button(checking ? "Checking…" : "See what's on sale now") {
                        Task { await check() }
                    }
                    .disabled(checking)
                    if let checkError {
                        Text(checkError).font(Theme.body(.footnote)).foregroundStyle(Theme.red)
                    }
                    if let hits {
                        if hits.isEmpty {
                            Text("Nothing on your list is on sale at your stores this week.")
                                .font(Theme.body(.footnote))
                        }
                        ForEach(hits) { hit in
                            VStack(alignment: .leading, spacing: 2) {
                                Text(hit.line).font(Theme.body(.subheadline))
                                Text(hit.alert ? "Worth an alert" : "On sale, but under \(prefs.watchAlertPct)%")
                                    .font(Theme.body(.caption, weight: .semibold))
                                    .foregroundStyle(hit.alert ? Theme.sage : Theme.ink.opacity(0.55))
                            }
                        }
                    }
                } header: {
                    Text("This week")
                } footer: {
                    Text("We check once a day, in the morning, and send at most one sale alert every 6 days, listing everything worth it. The same sale is never sent twice. Alerts are for your starred stores, or the three closest if you haven't starred any.")
                }
            }
        }
        .creamBackground()
        .font(Theme.body())
        .foregroundStyle(Theme.ink)
        .navigationTitle("Sale alerts")
        .task { blocked = await PushNotifications.isBlocked() }
    }

    private func addItem() {
        let item = newItem.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !item.isEmpty, item.count <= 40 else { return }
        if !prefs.watchCustom.contains(where: { $0.caseInsensitiveCompare(item) == .orderedSame }) {
            askPermissionIfNeeded()
            prefs.watchCustom.append(item)
        }
        newItem = ""
    }

    /// Switching anything on asks iOS for notification permission first (only asks once).
    private func allowed(_ binding: Binding<Bool>) -> Binding<Bool> {
        Binding(get: { binding.wrappedValue }, set: { on in
            if on { askPermissionIfNeeded() }
            binding.wrappedValue = on
        })
    }

    private func askPermissionIfNeeded() {
        guard !prefs.wantsSaleAlerts || blocked else { return }
        Task { blocked = !(await PushNotifications.requestPermission()) }
    }

    private func check() async {
        checking = true
        checkError = nil
        defer { checking = false }
        do {
            hits = try await SaleWatch.checkNow(prefs)
        } catch {
            checkError = Backend.friendlyMessage(for: error)
        }
    }
}
