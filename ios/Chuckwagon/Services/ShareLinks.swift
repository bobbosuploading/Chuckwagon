import Foundation

/// Links to shared meals and plans: https://chuckwagon-ebbcc.web.app/m/{id}, or chuckwagon://m/{id}
/// from the web page's "Open in Chuckwagon" button (functions/src/sharedMeals.ts).
enum ShareLinks {
    static let host = "chuckwagon-ebbcc.web.app"
    static let schemes: Set<String> = ["chuckwagon", "chuckwagon-dev"]

    /// A link the backend made for one meal or a plan.
    struct Link: Identifiable, Hashable {
        var id: String
        var url: URL
        var title: String

        /// The words that go with the link in Messages.
        var message: String { "\(title), from Chuckwagon:" }
    }

    static func url(for id: String) -> URL {
        URL(string: "https://\(host)/m/\(id)")!
    }

    /// The shared item's id, if this URL is a shared-meal link.
    static func sharedId(from url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        let id: String?
        if let scheme = url.scheme?.lowercased(), schemes.contains(scheme) {
            // chuckwagon://m/{id}: "m" is the host.
            id = url.host == "m" ? parts.first : nil
        } else if url.host?.lowercased() == host, parts.count == 2, parts[0] == "m" {
            id = parts[1]
        } else {
            id = nil
        }
        guard let id, isCode(id) else { return nil }
        return id
    }

    /// The invite code, if this URL is a link to join a household's shared shopping list:
    /// https://chuckwagon-ebbcc.web.app/h/{code} or chuckwagon://h/{code} (functions/src/households.ts).
    static func inviteCode(from url: URL) -> String? {
        let parts = url.pathComponents.filter { $0 != "/" }
        let code: String?
        if let scheme = url.scheme?.lowercased(), schemes.contains(scheme) {
            code = url.host == "h" ? parts.first : nil
        } else if url.host?.lowercased() == host, parts.count == 2, parts[0] == "h" {
            code = parts[1]
        } else {
            code = nil
        }
        guard let code, isCode(code) else { return nil }
        return code
    }

    /// Share ids and invite codes: 10 letters and digits.
    private static func isCode(_ s: String) -> Bool {
        s.count == 10 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber) }
    }
}

/// Meals and plans other people shared with this phone, newest first, so they can be found
/// again under My plans. Kept on the device only.
enum SharedInbox {
    struct Item: Codable, Hashable, Identifiable {
        var id: String
        var title: String
        var kind: String
        var storeName: String
        var openedAt: Date
    }

    private static let key = "sharedWithMe"
    private static let maxItems = 50

    static func items() -> [Item] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let items = try? JSONDecoder().decode([Item].self, from: data) else { return [] }
        return items
    }

    static func save(id: String, shared: SharedMeals) {
        var list = items().filter { $0.id != id }
        list.insert(Item(id: id, title: shared.title, kind: shared.kind, storeName: shared.storeName, openedAt: .now), at: 0)
        write(Array(list.prefix(maxItems)))
    }

    static func remove(ids: [String]) {
        write(items().filter { !ids.contains($0.id) })
    }

    private static func write(_ items: [Item]) {
        if let data = try? JSONEncoder().encode(items) { UserDefaults.standard.set(data, forKey: key) }
    }
}
