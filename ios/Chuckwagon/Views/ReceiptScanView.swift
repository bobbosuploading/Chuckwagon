import PhotosUI
import SwiftUI
import UIKit

/// "Scan a receipt or ad". A receipt photo teaches Chuckwagon a store's everyday prices,
/// so meal plans can price the items that aren't on sale. Sale prices are tagged and kept
/// out of the everyday prices (functions/src/receiptSales.ts).
/// A weekly ad photo adds that week's deals for a store whose ad we can't load
/// automatically, and can add the store itself (functions/src/adScans.ts).
/// Several ad pages can be picked at once and are treated as one ad: store websites often
/// print the sale dates on only one page, so pages without dates use the dates from the
/// others (or a guess the shopper can change under "Sale dates").
/// Either kind can be for any nearby store, or for "Another store" that isn't in
/// Chuckwagon yet: it's named from the photo (or what the shopper types) and added near them.
struct ReceiptScanView: View {
    enum Mode: String, CaseIterable, Identifiable {
        case receipt = "Receipt"
        case ad = "Weekly ad"
        var id: String { rawValue }
    }

    let store: Store?
    /// Every nearby store, for the "Store" picker.
    var myStores: [Store] = []
    /// Called with a store's id when a scan added it.
    var onStoreAdded: (String) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @Environment(Preferences.self) private var prefs
    @State private var mode: Mode = .receipt
    /// The store the photo is from; nil means "another store" (named from the photo or typed).
    @State private var pickedStoreId: String?
    /// The store's name, for "Another store". Optional: the name printed on the photo wins.
    @State private var otherStoreName = ""
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showingCamera = false
    @State private var scanning = false
    /// "Reading page 2 of 5…" while several ad pages are being read.
    @State private var pageProgress: (done: Int, total: Int)?
    @State private var result: Backend.ReceiptScan?
    /// Ad pages scanned on this screen for the picked store, in order. They're one ad.
    @State private var adPages: [Backend.AdScan] = []
    /// The dates for those pages, and where they came from.
    @State private var adDates: AdDates?
    @State private var editingDates = false
    @State private var editFrom = Date()
    @State private var editTo = Date()
    @State private var savingDates = false
    @State private var error: String?

    /// The sale dates for the ad pages on this screen.
    struct AdDates: Equatable {
        var validFrom: String?
        var validTo: String
        /// "printed", "recent-scan", "usual-week" or "shopper".
        var source: String
        var guessed: Bool { source == "recent-scan" || source == "usual-week" || source == "other-pages" }
    }

    /// Most ad pages a shopper can pick at once (the daily limit is 10 pages).
    private static let maxAdPages = 10

    init(store: Store?, myStores: [Store] = [], onStoreAdded: @escaping (String) -> Void = { _ in }) {
        self.store = store
        self.myStores = myStores
        self.onStoreAdded = onStoreAdded
        _pickedStoreId = State(initialValue: store?.id)
    }

    private var canScan: Bool { !scanning }
    private var pickedStore: Store? { pickedStoreId == nil ? nil : pickerStores.first { $0.id == pickedStoreId } }
    /// The picker's stores: nearby ones, plus the one on the home screen if it isn't among them.
    private var pickerStores: [Store] {
        guard let store, !myStores.contains(where: { $0.id == store.id }) else { return myStores }
        return [store] + myStores
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Picker("What are you scanning?", selection: $mode) {
                        ForEach(Mode.allCases) { Text($0.rawValue).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .disabled(scanning)
                    Picker("Store", selection: $pickedStoreId) {
                        ForEach(pickerStores) { Text($0.name).tag($0.id) }
                        Text("Another store").tag(String?.none)
                    }
                    .disabled(scanning)
                    if pickedStoreId == nil {
                        TextField("Store name, like Brookshire Brothers", text: $otherStoreName)
                            .textInputAutocapitalization(.words)
                            .autocorrectionDisabled()
                            .disabled(scanning)
                    }
                    Text(intro)
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.8))
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showingCamera = true } label: { Label("Take a photo", systemImage: "camera.fill") }
                            .disabled(!canScan)
                    }
                    PhotosPicker(selection: $pickerItems,
                                 maxSelectionCount: mode == .ad ? Self.maxAdPages : 1,
                                 selectionBehavior: .ordered,
                                 matching: .images) {
                        Label(mode == .ad ? "Choose pages from Photos" : "Choose from Photos", systemImage: "photo.on.rectangle")
                    }
                    .disabled(!canScan)
                } footer: {
                    Text(mode == .receipt
                         ? "Lay the receipt flat in good light. We keep the prices, not the photo."
                         : "One page per photo, flat and in good light. Pick up to \(Self.maxAdPages) pages at once, and they count as one ad: if only one page shows the dates the prices are good for, the rest use them. Coupons can't be scanned yet. We keep the deals, not the photo.")
                }
                .onChange(of: mode) { _, _ in resetScans() }
                .onChange(of: pickedStoreId) { _, _ in resetScans() }

                if scanning {
                    Section { HStack { ProgressView(); Text(progressText).padding(.leading, 8) } }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Color.chuckRed) }
                }
                if mode == .ad, let adDates {
                    Section { datesView(adDates) } header: { Text("Sale dates") }
                }
                if let reward = result?.reward ?? adPages.last?.reward {
                    Section { rewardView(reward) }
                }
                if let result {
                    Section {
                        ForEach(result.items, id: \.self) { item in
                            itemRow(item)
                        }
                    } header: {
                        Text("Learned \(result.items.count) prices")
                    } footer: {
                        if result.items.contains(where: { $0.salePrice != nil }) {
                            Text("Sale prices don't count as everyday prices. We keep the regular price when we know it.")
                        }
                    }
                }
                if let last = adPages.last {
                    let deals = adPages.flatMap(\.deals)
                    Section {
                        ForEach(Array(deals.enumerated()), id: \.offset) { adDealRow($0.element) }
                    } header: {
                        Text("Added \(deals.count) deals at \(last.storeName)")
                    } footer: {
                        Text(adFooter(last))
                    }
                }
            }
            .navigationTitle(mode == .receipt ? "Scan a receipt" : "Scan a weekly ad")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .creamBackground()
            .sheet(isPresented: $showingCamera) {
                CameraPicker { image in
                    Task {
                        if mode == .ad { await scanAdPages([image]) } else { await scan(image) }
                    }
                }
                .ignoresSafeArea()
            }
            .onChange(of: pickerItems) { _, items in
                guard !items.isEmpty else { return }
                Task {
                    var images: [UIImage] = []
                    for item in items {
                        if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                            images.append(image)
                        }
                    }
                    pickerItems = []
                    if images.isEmpty {
                        error = items.count == 1 ? "Couldn't open that photo." : "Couldn't open those photos."
                    } else if mode == .ad {
                        await scanAdPages(images, unreadable: items.count - images.count)
                    } else {
                        await scan(images[0])
                    }
                }
            }
        }
    }

    private var intro: String {
        switch mode {
        case .receipt:
            if let chosen = pickedStore {
                return "Snap your \(chosen.chain) receipt and we'll learn its everyday prices. Your plans get more accurate totals, and so does everyone shopping \(chosen.chain)."
            }
            return "Shopped somewhere that isn't in the list? Snap the receipt and we'll add the store near \(prefs.zip.isEmpty ? "you" : prefs.zip) with its prices. We read the store's name from the receipt, or type it above."
        case .ad:
            if let chosen = pickedStore {
                return "Snap a page of \(chosen.chain)'s printed weekly ad and its deals go into your plans, and everyone else's near you."
            }
            return "Have a printed ad from a store that isn't in the list, like a local grocer? Snap a page and we'll add the store near \(prefs.zip.isEmpty ? "you" : prefs.zip) with its deals. Type its name above if the page doesn't show it."
        }
    }

    private func adFooter(_ scan: Backend.AdScan) -> String {
        var parts: [String] = []
        if adPages.contains(where: \.newStore) { parts.append("We added \(scan.storeName) to your stores.") }
        if adPages.count > 1 { parts.append("From \(adPages.count) pages.") }
        parts.append("Good through \(Self.shortDate(adDates?.validTo ?? scan.validTo)). These deals go away when the ad ends.")
        parts.append("Scan the other pages too for more deals.")
        return parts.joined(separator: " ")
    }

    private var progressText: String {
        if mode == .receipt { return "Reading your receipt…" }
        if let pageProgress, pageProgress.total > 1 { return "Reading page \(pageProgress.done) of \(pageProgress.total)…" }
        return "Reading the ad…"
    }

    private func resetScans() {
        error = nil
        result = nil
        adPages = []
        adDates = nil
        editingDates = false
    }

    /// "Wed, Nov 11 – Tue, Nov 17", or "Through Tue, Nov 17".
    private static func dateRange(_ dates: AdDates) -> String {
        let to = longDate(dates.validTo)
        guard let from = dates.validFrom else { return "Through \(to)" }
        return "\(longDate(from)) – \(to)"
    }

    private func datesNote(_ dates: AdDates) -> String {
        switch dates.source {
        case "recent-scan":
            return "These pages don't show their dates, so we used the dates from this store's ad that was scanned recently. If they're wrong, change them."
        case "usual-week", "other-pages":
            return "These pages don't show their dates, so we guessed this week's ad, Wednesday to Tuesday. If that's wrong, change them, or scan the page that shows the dates."
        case "shopper":
            return "You set these dates. They apply to every page you scanned here."
        default:
            return adPages.contains(where: { !$0.datesPrinted })
                ? "Read from the ad. The pages without dates use these too."
                : "Read from the ad."
        }
    }

    @ViewBuilder
    private func datesView(_ dates: AdDates) -> some View {
        if editingDates {
            DatePicker("Starts", selection: $editFrom, displayedComponents: .date)
            DatePicker("Ends", selection: $editTo, in: editFrom..., displayedComponents: .date)
            HStack {
                Button("Cancel") { editingDates = false }
                    .buttonStyle(.borderless)
                Spacer()
                if savingDates { ProgressView() }
                Button("Save dates") { Task { await saveDates() } }
                    .buttonStyle(.borderless)
                    .bold()
                    .disabled(savingDates)
            }
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(Self.dateRange(dates)).font(Theme.body(.headline, weight: .bold))
                    if dates.guessed {
                        Text("GUESSED")
                            .font(.system(size: 11, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.red, in: Capsule())
                    }
                }
                Text(datesNote(dates)).font(.caption).foregroundStyle(.secondary)
            }
            Button(dates.guessed ? "Change dates" : "Dates wrong? Change them") {
                editFrom = Self.day(dates.validFrom) ?? Calendar.current.date(byAdding: .day, value: -6, to: Self.day(dates.validTo) ?? Date()) ?? Date()
                editTo = Self.day(dates.validTo) ?? Date()
                editingDates = true
            }
            .disabled(scanning)
        }
    }

    /// Reads ad pages one at a time, in order, as one ad. A page without dates uses the dates
    /// already known for this ad; when a later page shows the dates, earlier guessed pages move to them.
    private func scanAdPages(_ images: [UIImage], unreadable: Int = 0) async {
        scanning = true
        error = nil
        result = nil
        editingDates = false
        defer { scanning = false; pageProgress = nil }
        if pickedStoreId == nil, prefs.zip.isEmpty {
            error = "Set your ZIP code in Settings first, so we know where the store is."
            return
        }
        var problems: [String] = []
        if unreadable > 0 { problems.append("\(unreadable) photo\(unreadable == 1 ? "" : "s") couldn't be opened.") }
        for (i, image) in images.enumerated() {
            pageProgress = (i + 1, images.count)
            do {
                let page = try await Backend.scanAd(storeId: pickedStoreId, storeName: otherStoreName, zip: prefs.zip,
                                                    latitude: prefs.latitude, longitude: prefs.longitude,
                                                    validFrom: adDates?.validFrom, validTo: adDates?.validTo, image: image)
                adPages.append(page)
                if page.newStore { onStoreAdded(page.storeId) }
                // Later pages of the same ad go to the same store.
                if pickedStoreId == nil { otherStoreName = page.storeName }
                await useDates(from: page)
            } catch {
                let message = Backend.friendlyMessage(for: error)
                problems.append(images.count > 1 ? "Page \(i + 1): \(message)" : message)
                // Out of scans for today: the rest would fail the same way.
                if Backend.isLimitReached(error) { break }
            }
        }
        if !problems.isEmpty { self.error = problems.joined(separator: "\n") }
    }

    /// Keeps one set of dates for the ad. Printed dates beat guessed ones: pages that were
    /// guessed earlier move to the printed dates.
    private func useDates(from page: Backend.AdScan) async {
        let source = page.datesSource ?? "printed"
        guard let current = adDates else {
            adDates = AdDates(validFrom: page.validFrom, validTo: page.validTo, source: source)
            return
        }
        guard page.datesPrinted, current.guessed else { return }
        let printed = AdDates(validFrom: page.validFrom, validTo: page.validTo, source: "printed")
        do {
            try await moveGuessedPages(to: printed)
            adDates = printed
        } catch {
            self.error = "The other pages are still set to \(Self.dateRange(current)). \(Backend.friendlyMessage(for: error))"
        }
    }

    /// Moves every page scanned here that doesn't already end on `dates.validTo`.
    private func moveGuessedPages(to dates: AdDates, includePrinted: Bool = false) async throws {
        var moved = Set<String>()
        for page in adPages where page.validTo != dates.validTo && (includePrinted || !page.datesPrinted) {
            let key = "\(page.storeId)|\(page.validTo)"
            if moved.insert(key).inserted {
                try await Backend.fixAdDates(storeId: page.storeId, fromValidTo: page.validTo, validFrom: dates.validFrom, validTo: dates.validTo)
            }
        }
        for i in adPages.indices where moved.contains("\(adPages[i].storeId)|\(adPages[i].validTo)") {
            adPages[i].validTo = dates.validTo
            adPages[i].validFrom = dates.validFrom
        }
    }

    private func saveDates() async {
        savingDates = true
        defer { savingDates = false }
        let picked = AdDates(validFrom: Self.iso(editFrom), validTo: Self.iso(editTo), source: "shopper")
        do {
            try await moveGuessedPages(to: picked, includePrinted: true)
            adDates = picked
            editingDates = false
            error = nil
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }

    /// "2026-11-18" -> "Wed, Nov 18".
    private static func longDate(_ iso: String) -> String {
        guard let date = day(iso) else { return iso }
        return date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
    }

    private static func day(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return try? Date(iso, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
    }

    private static func iso(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(timeZone: .current).year().month().day())
    }

    /// "2026-11-18" -> "Nov 18".
    private static func shortDate(_ iso: String) -> String {
        guard let date = try? Date(iso, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day()) else { return iso }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }

    private func scan(_ image: UIImage) async {
        scanning = true
        error = nil
        result = nil
        defer { scanning = false }
        if pickedStoreId == nil, prefs.zip.isEmpty {
            error = "Set your ZIP code in Settings first, so we know where the store is."
            return
        }
        do {
            switch mode {
            case .receipt:
                let scan = try await Backend.scanReceipt(storeId: pickedStoreId, storeName: otherStoreName, zip: prefs.zip,
                                                         latitude: prefs.latitude, longitude: prefs.longitude, image: image)
                result = scan
                if scan.newStore == true, let id = scan.storeId { onStoreAdded(id) }
                if pickedStoreId == nil, let name = scan.storeName, !name.isEmpty { otherStoreName = name }
            case .ad:
                await scanAdPages([image])
            }
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }

    private func adDealRow(_ deal: Backend.AdScan.Deal) -> some View {
        let per = deal.soldBy == "WEIGHT" ? "/lb" : ""
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text([deal.brand, deal.name].compactMap { $0 }.joined(separator: " "))
                if let size = deal.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                if let promo = deal.promo { Text(promo).font(.caption).foregroundStyle(Theme.red) }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 2) {
                if let sale = deal.salePrice { Text(sale.dollars + per).bold().foregroundStyle(Theme.red) }
                if let regular = deal.regularPrice {
                    Text("reg " + regular.dollars + per).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func itemRow(_ item: Backend.ReceiptScan.Item) -> some View {
        let per = item.soldBy == "WEIGHT" ? "/lb" : ""
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.name)
                if let size = item.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                if item.salePrice != nil {
                    Text(item.saved == false ? "Sale. Regular price not known yet." : saleNote(item.saleReason))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let sale = item.salePrice {
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("SALE")
                            .font(.system(size: 11, weight: .black, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.red, in: Capsule())
                        Text(sale.dollars + per).bold().foregroundStyle(Theme.red)
                    }
                    if item.saved != false {
                        Text("reg " + item.price.dollars + per)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            } else {
                Text(item.price.dollars + per).bold()
            }
        }
    }

    private func saleNote(_ reason: String?) -> String {
        switch reason {
        case "ad": "In this week's ad."
        case "below-usual": "Well below the usual price."
        default: "Discount on the receipt."
        }
    }

    @ViewBuilder
    private func rewardView(_ reward: Backend.ReceiptScan.Reward) -> some View {
        if reward.earned {
            VStack(alignment: .leading, spacing: 6) {
                Label(reward.earnedChefPick == true ? "You earned a free Chef's pick!" : "Thanks! +1 meal plan today",
                      systemImage: reward.earnedChefPick == true ? "star.fill" : "gift.fill")
                    .font(Theme.body(.headline, weight: .bold))
                    .foregroundStyle(Theme.red)
                if let credits = reward.chefPickCredits, credits > 0 {
                    Text("Free Chef's picks: \(credits). Turn on Chef's pick when you plan to use one.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                if let left = reward.receiptsToNextChefPick, reward.earnedChefPick != true {
                    Text("\(left) more scan\(left == 1 ? "" : "s") until a free Chef's pick.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        } else {
            Text(reward.reason == "already-scanned"
                 ? "This was already scanned, so no reward this time. The prices still help!"
                 : "We couldn't read enough prices for a reward. Try a flatter, brighter photo.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    var onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
