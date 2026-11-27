import FirebaseAuth
import FirebaseFunctions
import FirebaseMessaging
import UIKit
import UserNotifications

extension Notification.Name {
    /// Firebase gave this phone a new push token (it also repeats it on each launch).
    static let pushTokenChanged = Notification.Name("ChuckwagonPushTokenChanged")
}

/// Opt-in push notifications through Firebase Cloud Messaging: "new deals are in" for the
/// shopper's stores, and a weekly meal planning reminder. The backend decides when to send
/// (functions/src/notifications.ts); the app only sends the shopper's choices and push token.
enum PushNotifications {
    private static let tokenKey = "fcmToken"
    private static let sentKey = "notifySettingsSent"

    static var token: String? { UserDefaults.standard.string(forKey: tokenKey) }

    static func saveToken(_ token: String?) {
        UserDefaults.standard.set(token, forKey: tokenKey)
        NotificationCenter.default.post(name: .pushTokenChanged, object: nil)
    }

    /// Whether iOS lets Chuckwagon show notifications, without asking.
    static func isAllowed() async -> Bool {
        switch await UNUserNotificationCenter.current().notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        default: return false
        }
    }

    /// Whether the shopper turned Chuckwagon's notifications off in iPhone Settings.
    static func isBlocked() async -> Bool {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .denied
    }

    /// Asks iOS for permission the first time, then registers for a push token.
    /// Returns false if the shopper said no (now or earlier, in iPhone Settings).
    @MainActor
    static func requestPermission() async -> Bool {
        let center = UNUserNotificationCenter.current()
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            break
        case .denied:
            return false
        default:
            guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return false }
        }
        UIApplication.shared.registerForRemoteNotifications()
        return true
    }

    /// On launch: get a fresh push token if the shopper has notifications on.
    @MainActor
    static func registerIfWanted(_ prefs: Preferences) async {
        guard prefs.wantsNotifications, await isAllowed() else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    /// Sends the shopper's choices to the backend. Skips the call when nothing changed,
    /// unless `force` (on launch, so the backend picks up a token iOS turned back on).
    @MainActor
    static func sync(_ prefs: Preferences, force: Bool = false) async {
        guard Auth.auth().currentUser != nil else { return }
        let wants = prefs.wantsNotifications
        let pushToken = wants ? (Self.token ?? "") : ""
        // No token yet: it arrives shortly after permission is given, and syncs then.
        if wants && pushToken.isEmpty { return }
        let sent = UserDefaults.standard.string(forKey: sentKey)
        // Never turned on: nothing to turn off.
        if !wants && sent == nil { return }

        var storeIds: [String] = []
        if prefs.notifyNewDeals { storeIds = await dealStoreIds(prefs) }
        let timeZone = TimeZone.current.identifier
        let signature = [pushToken, "\(prefs.notifyNewDeals)", "\(prefs.planReminderDay)", "\(prefs.planReminderHour)",
                         timeZone, storeIds.joined(separator: ",")].joined(separator: "|")
        if !force && sent == signature { return }
        let payload: [String: Any] = [
            "token": pushToken,
            "deals": prefs.notifyNewDeals,
            "planDay": prefs.planReminderDay,
            "planHour": prefs.planReminderHour,
            "timeZone": timeZone,
            "storeIds": storeIds,
        ]
        do {
            _ = try await Functions.functions().httpsCallable("saveNotificationSettings").call(payload)
            UserDefaults.standard.set(signature, forKey: sentKey)
        } catch {
            // Tried again on the next change or launch.
        }
    }

    /// Stores to watch for new ads: the starred ones, or the three closest if none are starred.
    @MainActor
    private static func dealStoreIds(_ prefs: Preferences) async -> [String] {
        if !prefs.favoriteStoreIds.isEmpty { return Array(prefs.favoriteStoreIds.prefix(8)) }
        guard let stores = try? await Backend.stores() else { return [] }
        return prefs.nearbyClosestFirst(stores).prefix(3).compactMap(\.id)
    }

    /// "Send a test notification" in Settings.
    static func sendTest() async throws {
        _ = try await Functions.functions().httpsCallable("sendTestNotification").call(["token": token ?? ""])
    }
}

/// Hands Apple's push token to Firebase, passes Firebase's token to PushNotifications, and shows
/// notifications that arrive while Chuckwagon is open.
final class AppDelegate: NSObject, UIApplicationDelegate, MessagingDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        ChuckwagonApp.configureFirebase()
        Messaging.messaging().delegate = self
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Messaging.messaging().apnsToken = deviceToken
    }

    func messaging(_ messaging: Messaging, didReceiveRegistrationToken fcmToken: String?) {
        DispatchQueue.main.async { PushNotifications.saveToken(fcmToken) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }
}
