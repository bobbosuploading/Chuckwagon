import PhotosUI
import SwiftUI
import UIKit

/// "Share a deal": a grocery deal the shopper saw on Facebook, TikTok, Reddit, a deal site or in a
/// text. They share a screenshot, a link or the words of the post, pick the store, and it shows up
/// for everyone shopping there as "spotted by a shopper" (functions/src/sharedDeals.ts).
/// Opens from the home screen, or by itself with a share from another app (ShareInbox).
struct ShareDealView: View {
    let myStores: [Store]
    /// Called with the store's id after a deal was added, so the home screen can show it.
    var onShared: (String) -> Void = { _ in }
    /// A share from another app, to fill in the form.
    private let inboxId: String?
    @Environment(\.dismiss) private var dismiss
    @State private var storeId: String?
    @State private var link: String
    @State private var text: String
    @State private var image: UIImage?
    @State private var pickerItem: PhotosPickerItem?
    @State private var sending = false
    @State private var result: Backend.ShareResult?
    @State private var error: String?

    init(store: Store?, myStores: [Store], shared: (item: ShareInbox.Item, image: UIImage?)? = nil, onShared: @escaping (String) -> Void = { _ in }) {
        self.myStores = myStores
        self.onShared = onShared
        inboxId = shared?.item.id
        _storeId = State(initialValue: store?.id ?? myStores.first?.id)
        _image = State(initialValue: shared?.image)
        // Some apps share a link inside the text; pull it out so the backend can read the page.
        let sharedText = shared?.item.text ?? ""
        let foundLink = shared?.item.url ?? Self.firstLink(in: sharedText)
        _link = State(initialValue: foundLink ?? "")
        _text = State(initialValue: sharedText.replacingOccurrences(of: foundLink ?? "\u{0}", with: "").trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private var hasSomething: Bool {
        image != nil || !link.trimmingCharacters(in: .whitespaces).isEmpty || !text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Saw a grocery deal on Facebook, TikTok, Reddit or a deal site? Share it and everyone shopping that store will see it. A screenshot that shows the item and price works best.")
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.8))
                    Picker("Where's the deal?", selection: $storeId) {
                        ForEach(myStores) { Text($0.name).tag($0.id) }
                    }
                    .disabled(sending || result != nil)
                }

                Section("The post") {
                    if let image {
                        HStack(alignment: .top) {
                            Image(uiImage: image)
                                .resizable()
                                .scaledToFit()
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            Spacer()
                            Button(role: .destructive) { self.image = nil } label: { Image(systemName: "xmark.circle.fill") }
                                .buttonStyle(.borderless)
                                .accessibilityLabel("Remove screenshot")
                        }
                    }
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        Label(image == nil ? "Choose a screenshot" : "Choose a different screenshot", systemImage: "photo.on.rectangle")
                    }
                    TextField("Link to the post (optional)", text: $link)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Or paste what the post says", text: $text, axis: .vertical)
                        .lineLimit(3...8)
                    PasteButton(payloadType: String.self) { strings in
                        guard let pasted = strings.first else { return }
                        let found = Self.firstLink(in: pasted)
                        if let found, link.isEmpty { link = found }
                        let rest = (found.map { pasted.replacingOccurrences(of: $0, with: "") } ?? pasted)
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                        if !rest.isEmpty { text = rest }
                    }
                    .labelStyle(.titleAndIcon)
                }
                .disabled(sending || result != nil)

                if result == nil {
                    Section {
                        Button {
                            Task { await send() }
                        } label: {
                            HStack {
                                if sending { ProgressView().tint(.white).padding(.trailing, 6) }
                                Text(sending ? "Reading the deal…" : "Add this deal")
                            }
                        }
                        .buttonStyle(BigButtonStyle())
                        .disabled(!hasSomething || storeId == nil || sending)
                        .listRowBackground(Color.clear)
                    } footer: {
                        Text("Links from Facebook, Instagram and TikTok often need a login we don't have, so add a screenshot too. We keep the deal and the link, not the screenshot.")
                    }
                }

                if let error {
                    Section { Text(error).foregroundStyle(Color.chuckRed) }
                }

                if let result {
                    Section {
                        ForEach(result.deals, id: \.self) { dealRow($0) }
                    } header: {
                        Text("Added \(result.deals.count) deal\(result.deals.count == 1 ? "" : "s")")
                    } footer: {
                        Text(footer(result))
                    }
                    Section {
                        Button("Share another") { reset() }
                    }
                }
            }
            .navigationTitle("Share a deal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { finish() } }
            .creamBackground()
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let picked = UIImage(data: data) {
                        image = picked
                    } else {
                        error = "Couldn't open that picture."
                    }
                    pickerItem = nil
                }
            }
        }
    }

    private func dealRow(_ deal: Backend.ShareResult.Deal) -> some View {
        let per = deal.soldBy == "WEIGHT" ? "/lb" : ""
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text([deal.brand, deal.name].compactMap { $0 }.joined(separator: " "))
                if let size = deal.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                if let promo = deal.promo { Text(promo).font(.caption).foregroundStyle(Theme.red) }
                if deal.alreadyShared {
                    Text("Another shopper shared this too. We counted you as \"still there\".")
                        .font(.caption).foregroundStyle(.secondary)
                }
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

    private func footer(_ r: Backend.ShareResult) -> String {
        let place = r.scope == "chain" ? "at every \(chainName(r)) store" : "at \(r.storeName)"
        let until = r.endDateFromPost
            ? "until \(Self.shortDate(r.validTo)), when the post says it ends"
            : "through \(Self.shortDate(r.validTo)) unless shoppers say it's still there"
        let clearance = r.clearance ? " Clearance varies by store, so it only shows at this one." : ""
        return "It shows \(place) \(until). If it's gone when you get there, tap Gone on the home screen.\(clearance)"
    }

    private func chainName(_ r: Backend.ShareResult) -> String {
        myStores.first { $0.id == r.storeId }?.chain ?? r.storeName
    }

    private func send() async {
        guard let storeId else { return }
        sending = true
        error = nil
        defer { sending = false }
        do {
            let trimmedLink = link.trimmingCharacters(in: .whitespacesAndNewlines)
            let url = trimmedLink.isEmpty || trimmedLink.hasPrefix("http") ? trimmedLink : "https://" + trimmedLink
            result = try await Backend.shareDeal(storeId: storeId, image: image, url: url, text: text.trimmingCharacters(in: .whitespacesAndNewlines))
            if let inboxId { ShareInbox.remove(inboxId) }
            onShared(storeId)
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }

    private func reset() {
        result = nil
        error = nil
        image = nil
        link = ""
        text = ""
    }

    private func finish() {
        // A share from another app that wasn't sent: drop it so it doesn't pop up again.
        if let inboxId { ShareInbox.remove(inboxId) }
        dismiss()
    }

    static func firstLink(in text: String) -> String? {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        return detector.firstMatch(in: text, range: range)?.url?.absoluteString
    }

    /// "2026-11-18" -> "Nov 18".
    static func shortDate(_ iso: String) -> String {
        guard let date = try? Date(iso, strategy: Date.ISO8601FormatStyle(timeZone: .current).year().month().day()) else { return iso }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}

/// A deal shoppers shared, on the home screen, with "Still there" and "Gone".
struct SharedDealCard: View {
    let deal: SharedDeal
    var onVote: (Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "megaphone.fill")
                Text(deal.clearance == true ? "CLEARANCE" : deal.scope == "chain" ? "ALL \(deal.chain.uppercased())" : "SPOTTED")
            }
            .font(.system(size: 11, weight: .black, design: .rounded))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Theme.mustard, in: Capsule())

            Text([deal.brand, deal.name].compactMap { $0 }.joined(separator: " "))
                .font(Theme.body(.subheadline, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .lineLimit(2, reservesSpace: true)
            if let sale = deal.salePrice {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(sale.dollars + deal.perUnit)
                        .font(.system(.title3, design: .rounded, weight: .heavy))
                        .foregroundStyle(Theme.red)
                    if let regular = deal.regularPrice {
                        Text(regular.dollars).font(Theme.body(.caption)).strikethrough().foregroundStyle(Theme.ink.opacity(0.45))
                    }
                }
            }
            if let promo = deal.promo {
                Text(promo).font(Theme.body(.caption2, weight: .medium)).foregroundStyle(Theme.red).lineLimit(2)
            }
            Text("Through \(ShareDealView.shortDate(deal.validTo))" + (deal.stillThereCount > 1 ? " · \(deal.stillThereCount) say it's there" : ""))
                .font(Theme.body(.caption2))
                .foregroundStyle(Theme.ink.opacity(0.55))
            if let link = deal.url.flatMap(URL.init(string:)) {
                Link(destination: link) { Label("See the post", systemImage: "arrow.up.right.square") }
                    .font(Theme.body(.caption, weight: .semibold))
            }
            HStack(spacing: 8) {
                Button { onVote(true) } label: { Label("Still there", systemImage: "checkmark") }
                Button { onVote(false) } label: { Label("Gone", systemImage: "xmark") }
            }
            .font(Theme.body(.caption, weight: .semibold))
            .buttonStyle(.bordered)
            .tint(Theme.ink)
        }
        .padding(12)
        .frame(width: 210, alignment: .leading)
        .card()
    }
}
