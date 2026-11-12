import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// "Chuckwagon" in the share sheet. Saves the shared post (screenshot, link, text) for the app,
/// which finishes it when it opens (ShareInbox, ShareDealView). No sign-in or network here.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareSheetView(model: model) { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        })
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.save(items) }
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum State { case saving, saved, failed(String) }
    @Published var state: State = .saving

    func save(_ items: [NSExtensionItem]) async {
        var url: String?
        var texts: [String] = []
        var image: UIImage?
        for item in items {
            if let words = item.attributedContentText?.string, !words.isEmpty { texts.append(words) }
            for provider in item.attachments ?? [] {
                if image == nil, provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                    image = await Self.loadImage(provider)
                } else if url == nil, provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    if loaded.isFileURL {
                        if let data = try? Data(contentsOf: loaded), let picture = UIImage(data: data), image == nil { image = picture }
                    } else {
                        url = loaded.absoluteString
                    }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let words = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    texts.append(words)
                }
            }
        }
        let text = texts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard image != nil || url != nil || !text.isEmpty else {
            state = .failed("There's nothing here Chuckwagon can read. Try sharing a screenshot of the post.")
            return
        }
        state = ShareInbox.save(url: url, text: text.isEmpty ? nil : text, image: image)
            ? .saved
            : .failed("Couldn't save this for Chuckwagon. Open the app and use Share a deal instead.")
    }

    private static func loadImage(_ provider: NSItemProvider) async -> UIImage? {
        guard let loaded = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) else { return nil }
        if let picture = loaded as? UIImage { return picture }
        if let data = loaded as? Data { return UIImage(data: data) }
        if let file = loaded as? URL, let data = try? Data(contentsOf: file) { return UIImage(data: data) }
        return nil
    }
}

private struct ShareSheetView: View {
    @ObservedObject var model: ShareModel
    var done: () -> Void

    private let red = Color(red: 0.71, green: 0.22, blue: 0.16)
    private let ink = Color(red: 0.24, green: 0.17, blue: 0.12)

    var body: some View {
        VStack(spacing: 18) {
            Spacer()
            switch model.state {
            case .saving:
                ProgressView()
                Text("Saving…").foregroundStyle(ink)
            case .saved:
                Image(systemName: "megaphone.fill").font(.system(size: 44)).foregroundStyle(red)
                Text("Saved for Chuckwagon")
                    .font(.system(.title2, design: .serif, weight: .heavy))
                    .foregroundStyle(ink)
                Text("Open Chuckwagon to pick the store and add the deal. It's waiting for you there.")
                    .font(.system(.body, design: .rounded))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(ink.opacity(0.8))
            case .failed(let message):
                Image(systemName: "exclamationmark.triangle.fill").font(.system(size: 40)).foregroundStyle(red)
                Text(message)
                    .font(.system(.body, design: .rounded))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(ink)
            }
            Spacer()
            Button(action: done) {
                Text("Done")
                    .font(.system(.headline, design: .rounded, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(red, in: Capsule())
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(red: 0.98, green: 0.96, blue: 0.91).ignoresSafeArea())
    }
}
