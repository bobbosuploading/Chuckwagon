import PhotosUI
import SwiftUI
import UIKit

/// "Scan a receipt or ad". A receipt photo teaches Chuckwagon a store's everyday prices,
/// so meal plans can price the items that aren't on sale. Sale prices are tagged and kept
/// out of the everyday prices (functions/src/receiptSales.ts).
/// A weekly ad photo adds that week's deals for a store whose ad we can't load
/// automatically, and can add the store itself (functions/src/adScans.ts).
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
    @State private var pickerItem: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var scanning = false
    @State private var result: Backend.ReceiptScan?
    @State private var adResult: Backend.AdScan?
    @State private var error: String?

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
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        Label("Choose from Photos", systemImage: "photo.on.rectangle")
                    }
                    .disabled(!canScan)
                } footer: {
                    Text(mode == .receipt
                         ? "Lay the receipt flat in good light. We keep the prices, not the photo."
                         : "One page per photo, flat and in good light. Include the dates the prices are good for. Coupons can't be scanned yet. We keep the deals, not the photo.")
                }
                .onChange(of: mode) { _, _ in error = nil }
                .onChange(of: pickedStoreId) { _, _ in error = nil }

                if scanning {
                    Section { HStack { ProgressView(); Text(mode == .receipt ? "Reading your receipt…" : "Reading the ad…").padding(.leading, 8) } }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Color.chuckRed) }
                }
                if let reward = result?.reward ?? adResult?.reward {
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
                if let adResult {
                    Section {
                        ForEach(adResult.deals, id: \.self) { adDealRow($0) }
                    } header: {
                        Text("Added \(adResult.deals.count) deals at \(adResult.storeName)")
                    } footer: {
                        Text(adFooter(adResult))
                    }
                }
            }
            .navigationTitle(mode == .receipt ? "Scan a receipt" : "Scan a weekly ad")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .creamBackground()
            .sheet(isPresented: $showingCamera) {
                CameraPicker { image in Task { await scan(image) } }.ignoresSafeArea()
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        await scan(image)
                    } else {
                        error = "Couldn't open that photo."
                    }
                    pickerItem = nil
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
        var parts = ["Good through \(Self.shortDate(scan.validTo)). These deals go away when the ad ends."]
        if scan.newStore { parts.insert("We added \(scan.storeName) to your stores.", at: 0) }
        parts.append("Scan the other pages too for more deals.")
        return parts.joined(separator: " ")
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
        adResult = nil
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
                let scan = try await Backend.scanAd(storeId: pickedStoreId, storeName: otherStoreName, zip: prefs.zip,
                                                    latitude: prefs.latitude, longitude: prefs.longitude, image: image)
                adResult = scan
                if scan.newStore { onStoreAdded(scan.storeId) }
                // Later pages of the same ad go to the same store.
                if pickedStoreId == nil { otherStoreName = scan.storeName }
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
