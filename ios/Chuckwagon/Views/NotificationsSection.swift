import SwiftUI
import UIKit

/// Settings > Notifications: opt-in deals alerts, a weekly meal planning reminder, and sale alerts.
struct NotificationsSection: View {
    @Environment(Preferences.self) private var prefs
    @Environment(\.scenePhase) private var scenePhase
    @State private var blocked = false
    @State private var message: String?
    @State private var testing = false

    /// Reminder times offered, in the phone's own time zone.
    private static let hours: [(hour: Int, label: String)] = [(9, "9 AM"), (12, "Noon"), (17, "5 PM"), (19, "7 PM")]

    var body: some View {
        @Bindable var prefs = prefs
        Section {
            Toggle("New deals at my stores", isOn: Binding(
                get: { prefs.notifyNewDeals },
                set: { on in whenAllowed(on) { prefs.notifyNewDeals = on } }
            ))
            Picker("Meal planning reminder", selection: Binding(
                get: { prefs.planReminderDay },
                set: { day in whenAllowed(day >= 0) { prefs.planReminderDay = day } }
            )) {
                Text("Off").tag(-1)
                ForEach(0..<7, id: \.self) { day in
                    Text(Calendar.current.weekdaySymbols[day]).tag(day)
                }
            }
            if prefs.planReminderDay >= 0 {
                Picker("Remind me at", selection: $prefs.planReminderHour) {
                    ForEach(Self.hours, id: \.hour) { Text($0.label).tag($0.hour) }
                }
            }
            NavigationLink {
                SaleAlertsView()
            } label: {
                LabeledContent("Sale alerts", value: saleAlertsSummary)
            }
            if blocked {
                Text("Notifications are turned off for Chuckwagon in iPhone Settings.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.red)
                Button("Open iPhone Settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) {
                        UIApplication.shared.open(url)
                    }
                }
            } else if prefs.wantsNotifications {
                Button(testing ? "Sending…" : "Send a test notification") {
                    Task { await sendTest() }
                }
                .disabled(testing)
            }
            if let message {
                Text(message).font(Theme.body(.footnote)).foregroundStyle(Theme.ink.opacity(0.7))
            }
        } header: {
            Text("Notifications")
        } footer: {
            Text("At most one deals alert and one reminder a week. Sale alerts tell you when cuts you watch go on a big sale, or when it's cheaper to make your own bacon, ground beef or jerky. Deals and sale alerts are for your starred stores, or the three closest if you haven't starred any.")
        }
        .task { blocked = await PushNotifications.isBlocked() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { blocked = await PushNotifications.isBlocked() }
        }
    }

    private var saleAlertsSummary: String {
        let count = prefs.watchItems.count + prefs.watchCustom.count
            + [prefs.watchBacon, prefs.watchGroundBeef, prefs.watchJerky].filter { $0 }.count
        return count == 0 ? "Off" : "\(count) watched"
    }

    /// Turning something on asks iOS for permission first; turning it off just applies.
    private func whenAllowed(_ turningOn: Bool, apply: @escaping () -> Void) {
        guard turningOn else { apply(); return }
        Task {
            if await PushNotifications.requestPermission() {
                blocked = false
                apply()
            } else {
                blocked = true
            }
        }
    }

    private func sendTest() async {
        testing = true
        defer { testing = false }
        do {
            try await PushNotifications.sendTest()
            message = "Sent. It should show up in a few seconds."
        } catch {
            message = error.localizedDescription
        }
    }
}
