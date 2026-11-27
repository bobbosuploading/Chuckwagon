import FirebaseAuth
import FirebaseFirestore
import FirebaseFunctions
import Foundation

/// The shared shopping list: one list for everyone in the shopper's household, kept live in
/// Firestore (households/{id}/items) so adding or checking off an item shows up on every
/// member's phone right away. Works offline too; Firestore sends the changes when it can.
///
/// The household itself (who's in it) is changed only by the backend (functions/src/households.ts):
/// a shopper starts one on their first item, invites family by link, and others join from the link.
/// Apple's Family Sharing doesn't tell apps who's in a family, so the invite link stands in for it.
@MainActor
@Observable
final class HouseholdList {
    struct Item: Identifiable, Hashable {
        var id: String
        var text: String
        var note: String
        var aisle: String
        var checked: Bool
        var addedBy: String
        var addedByName: String
        var checkedBy: String?
        var forMeals: [String]
        var storeName: String
        /// Set on items added by scanning a barcode, so the exact product (brand and size) is kept.
        var barcode: String
        /// Worth buying extra of, carried over from a meal plan's grocery list.
        var stockUp: StockUp?
        var createdAt: Date?
    }

    struct Member: Identifiable, Hashable {
        var uid: String
        var name: String
        var id: String { uid }
    }

    /// Keeps the list a sensible size (Firestore rules can't count items).
    static let maxItems = 300
    /// Aisles in store order, matching the meal plan's grocery list.
    static let aisleOrder = ["Produce", "Meat", "Seafood", "Dairy", "Bakery", "Frozen", "Pantry", "Household", "Other"]

    private(set) var householdId: String?
    private(set) var members: [Member] = []
    private(set) var items: [Item] = []
    /// True until the first look at the shopper's account comes back.
    private(set) var loading = true
    private(set) var uid: String?

    /// The first name the others see beside items. Kept on this phone and sent when starting or joining.
    var myName: String {
        didSet { UserDefaults.standard.set(myName, forKey: Self.nameKey) }
    }
    private static let nameKey = "householdName"

    private var authHandle: AuthStateDidChangeListenerHandle?
    private var userListener: ListenerRegistration?
    private var householdListener: ListenerRegistration?
    private var itemsListener: ListenerRegistration?

    private var db: Firestore { Firestore.firestore() }
    private var functions: Functions { Functions.functions() }

    init() {
        myName = UserDefaults.standard.string(forKey: Self.nameKey) ?? ""
    }

    var isShared: Bool { members.count > 1 }
    var uncheckedCount: Int { items.filter { !$0.checked }.count }

    /// Everyone else in the household, by name.
    var othersText: String {
        let names = members.filter { $0.uid != uid }.map { $0.name.isEmpty ? "someone" : $0.name }
        return ListFormatter.localizedString(byJoining: names)
    }

    /// Starts listening. Follows sign-in changes (signing in with Apple keeps the same account;
    /// signing out starts a new one with no household).
    func start() {
        guard authHandle == nil else { return }
        authHandle = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            MainActor.assumeIsolated { self?.follow(uid: user?.uid) }
        }
    }

    private func follow(uid newUid: String?) {
        guard newUid != uid || userListener == nil else { return }
        uid = newUid
        userListener?.remove()
        userListener = nil
        listen(householdId: nil)
        guard let newUid else { loading = false; return }
        loading = true
        userListener = db.collection("users").document(newUid).addSnapshotListener { [weak self] snap, _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.loading = false
                let id = snap?.get("householdId") as? String
                if id != self.householdId { self.listen(householdId: id) }
            }
        }
    }

    private func listen(householdId id: String?) {
        householdListener?.remove()
        itemsListener?.remove()
        householdListener = nil
        itemsListener = nil
        householdId = id
        members = []
        items = []
        guard let id else { return }
        let ref = db.collection("households").document(id)
        householdListener = ref.addSnapshotListener { [weak self] snap, _ in
            MainActor.assumeIsolated {
                guard let self, let snap, snap.exists else { return }
                let uids = snap.get("members") as? [String] ?? []
                let names = snap.get("names") as? [String: String] ?? [:]
                self.members = uids.map { Member(uid: $0, name: names[$0] ?? "") }
            }
        }
        itemsListener = ref.collection("items").addSnapshotListener { [weak self] snap, _ in
            MainActor.assumeIsolated {
                guard let self, let snap else { return }
                self.items = snap.documents.map { Self.item(from: $0) }
                    .sorted { ($0.createdAt ?? .distantFuture, $0.id) < ($1.createdAt ?? .distantFuture, $1.id) }
            }
        }
    }

    private static func item(from doc: QueryDocumentSnapshot) -> Item {
        let d = doc.data(with: .estimate)
        return Item(
            id: doc.documentID,
            text: d["text"] as? String ?? "",
            note: d["note"] as? String ?? "",
            aisle: d["aisle"] as? String ?? "",
            checked: d["checked"] as? Bool ?? false,
            addedBy: d["addedBy"] as? String ?? "",
            addedByName: d["addedByName"] as? String ?? "",
            checkedBy: d["checkedBy"] as? String,
            forMeals: d["forMeals"] as? [String] ?? [],
            storeName: d["storeName"] as? String ?? "",
            barcode: d["barcode"] as? String ?? "",
            stockUp: stockUp(from: d["stockUp"]),
            createdAt: (d["createdAt"] as? Timestamp)?.dateValue()
        )
    }

    private static func stockUp(from raw: Any?) -> StockUp? {
        guard let m = raw as? [String: Any], let level = m["level"] as? String else { return nil }
        let text = { (k: String) in m[k] as? String ?? "" }
        return StockUp(level: level, reason: text("reason"), keep: text("keep"), howMuch: text("howMuch"), storage: text("storage"))
    }

    // MARK: Household

    private var trimmedName: String { String(myName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(30)) }

    /// The household's id, starting a list of the shopper's own if they have none yet.
    @discardableResult
    func ensureHousehold() async throws -> String {
        if let householdId { return householdId }
        let result = try await functions.httpsCallable("startHousehold").call(["name": trimmedName])
        guard let id = (result.data as? [String: Any])?["householdId"] as? String else {
            throw Self.error("Couldn't start your list. Please try again.")
        }
        if householdId != id { listen(householdId: id) }
        return id
    }

    /// A link that lets someone join this household for a week.
    func inviteLink() async throws -> URL {
        try await refreshSignIn()
        let result = try await functions.httpsCallable("householdInviteLink").call(["name": trimmedName])
        guard let s = (result.data as? [String: Any])?["url"] as? String, let url = URL(string: s) else {
            throw Self.error("Couldn't make an invite link. Please try again.")
        }
        return url
    }

    /// Who sent an invite: their name (may be empty) and how many people are on that list.
    func inviteInfo(code: String) async throws -> (fromName: String, members: Int) {
        let result = try await functions.httpsCallable("householdInviteInfo").call(["code": code])
        let data = result.data as? [String: Any]
        return (data?["fromName"] as? String ?? "", (data?["members"] as? NSNumber)?.intValue ?? 0)
    }

    func join(code: String) async throws {
        try await refreshSignIn()
        let result = try await functions.httpsCallable("joinHouseholdInvite").call(["code": code, "name": trimmedName])
        if let id = (result.data as? [String: Any])?["householdId"] as? String, id != householdId {
            listen(householdId: id)
        }
    }

    func leave() async throws {
        _ = try await functions.httpsCallable("leaveHouseholdList").call([:] as [String: Any])
        listen(householdId: nil)
    }

    /// Whether this account has signed in with Apple (needed to invite or join).
    var signedInWithApple: Bool {
        Auth.auth().currentUser?.providerData.contains { $0.providerID == "apple.com" } ?? false
    }

    /// Fresh sign-in token, so the backend sees a just-finished Apple sign-in.
    private func refreshSignIn() async throws {
        _ = try await Auth.auth().currentUser?.getIDTokenResult(forcingRefresh: true)
    }

    // MARK: Items

    private func itemsRef(_ id: String) -> CollectionReference {
        db.collection("households").document(id).collection("items")
    }

    private func newItemData(text: String, note: String = "", aisle: String = "", forMeals: [String] = [], storeName: String = "", barcode: String = "", stockUp: StockUp? = nil) -> [String: Any] {
        var data: [String: Any] = [
            "text": String(text.prefix(120)),
            "checked": false,
            "addedBy": uid ?? "",
            "createdAt": FieldValue.serverTimestamp(),
            "updatedAt": FieldValue.serverTimestamp(),
        ]
        if !note.isEmpty { data["note"] = String(note.prefix(120)) }
        if !aisle.isEmpty { data["aisle"] = String(aisle.prefix(40)) }
        if !trimmedName.isEmpty { data["addedByName"] = trimmedName }
        if !forMeals.isEmpty { data["forMeals"] = Array(forMeals.prefix(10)).map { String($0.prefix(80)) } }
        if !storeName.isEmpty { data["storeName"] = String(storeName.prefix(80)) }
        if let stockUp {
            data["stockUp"] = [
                "level": String(stockUp.level.prefix(20)), "reason": String(stockUp.reason.prefix(80)),
                "keep": String(stockUp.keep.prefix(20)), "howMuch": String(stockUp.howMuch.prefix(160)),
                "storage": String(stockUp.storage.prefix(300)),
            ]
        }
        if (8...14).contains(barcode.count), barcode.allSatisfy(\.isASCII), barcode.allSatisfy(\.isNumber) { data["barcode"] = barcode }
        return data
    }

    /// Adds one item typed by the shopper. Returns false if it's already on the list (not checked off).
    @discardableResult
    func add(_ text: String, note: String = "", barcode: String = "") async throws -> Bool {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        if items.contains(where: { !$0.checked && Self.key($0.text) == Self.key(text) }) { return false }
        guard items.count < Self.maxItems else { throw Self.error("Your list is full. Clear checked items to make room.") }
        let id = try await ensureHousehold()
        write(newItemData(text: text, note: note, barcode: barcode), to: itemsRef(id).document())
        return true
    }

    /// Adds a meal plan's grocery items that aren't checked off and aren't on the list already.
    /// Returns how many were added.
    func add(plan: MealPlan) async throws -> Int {
        let id = try await ensureHousehold()
        let onList = Set(items.filter { !$0.checked }.map { Self.key($0.text) })
        let multiStore = (plan.stores?.count ?? 0) > 1
        let fresh = plan.groceryList.filter { !$0.checked && !onList.contains(Self.key($0.item)) }
        let room = max(0, Self.maxItems - items.count)
        guard room > 0 || fresh.isEmpty else { throw Self.error("Your list is full. Clear checked items to make room.") }
        let batch = db.batch()
        let toAdd = fresh.prefix(room)
        for li in toAdd {
            batch.setData(newItemData(text: li.item, note: li.quantityNote, aisle: li.aisle,
                                      forMeals: li.forMeals, storeName: multiStore ? (li.storeName ?? "") : "",
                                      stockUp: li.stockUp),
                          forDocument: itemsRef(id).document())
        }
        batch.commit { _ in }
        return toAdd.count
    }

    /// Not awaited: Firestore shows the item right away and sends it when it can (works offline).
    private func write(_ data: [String: Any], to ref: DocumentReference) {
        ref.setData(data)
    }

    func setChecked(_ item: Item, _ checked: Bool) {
        guard let householdId else { return }
        var change: [String: Any] = ["checked": checked, "updatedAt": FieldValue.serverTimestamp()]
        change["checkedBy"] = checked ? (uid ?? "") : FieldValue.delete()
        // Show it right away; the listener confirms it.
        if let i = items.firstIndex(where: { $0.id == item.id }) { items[i].checked = checked }
        itemsRef(householdId).document(item.id).updateData(change)
    }

    func edit(_ item: Item, text: String, note: String) {
        guard let householdId else { return }
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        var change: [String: Any] = ["text": String(text.prefix(120)), "updatedAt": FieldValue.serverTimestamp()]
        let note = note.trimmingCharacters(in: .whitespacesAndNewlines)
        change["note"] = note.isEmpty ? FieldValue.delete() : String(note.prefix(120))
        itemsRef(householdId).document(item.id).updateData(change)
    }

    func delete(_ items: [Item]) {
        guard let householdId, !items.isEmpty else { return }
        let batch = db.batch()
        for item in items { batch.deleteDocument(itemsRef(householdId).document(item.id)) }
        batch.commit { _ in }
    }

    func clearChecked() { delete(items.filter(\.checked)) }

    /// The name to show for who added or checked an item ("You", "Sam", or nothing).
    func name(for memberUid: String?) -> String? {
        guard let memberUid, !memberUid.isEmpty else { return nil }
        if memberUid == uid { return "you" }
        let name = members.first { $0.uid == memberUid }?.name ?? ""
        return name.isEmpty ? nil : name
    }

    /// Items match loosely: case, spacing and punctuation don't count.
    nonisolated static func key(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter { CharacterSet.alphanumerics.contains($0) })
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "Chuckwagon", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
