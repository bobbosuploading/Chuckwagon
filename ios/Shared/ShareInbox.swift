import Foundation
import UIKit

/// Deals shared into Chuckwagon from other apps (Facebook, TikTok, Safari, Photos…).
///
/// The share extension can't sign in to Firebase, so it only saves what was shared (a screenshot,
/// a link, some text) into a folder both it and the app can reach (the App Group). The app picks
/// it up the next time it opens and finishes in ShareDealView, where the shopper picks the store.
///
/// The dev app has no App Group, so its inbox is always empty (it shares from inside the app).
enum ShareInbox {
    static let appGroup = "group.com.bobby.chuckwagon"

    /// One share waiting for the app.
    struct Item: Identifiable, Codable, Equatable {
        var id: String
        var url: String?
        var text: String?
        /// True when a screenshot was saved next to it (image.jpg).
        var hasImage: Bool
        var savedAt: Date
    }

    private static var folder: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent("SharedDeals", isDirectory: true)
    }

    /// Saves a share. Returns false when there's nowhere to save it.
    @discardableResult
    static func save(url: String?, text: String?, image: UIImage?) -> Bool {
        guard let folder else { return false }
        let id = UUID().uuidString
        let dir = folder.appendingPathComponent(id, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            var hasImage = false
            if let jpeg = image?.scaledForUpload(maxSide: 2000).jpegData(compressionQuality: 0.7) {
                try jpeg.write(to: dir.appendingPathComponent("image.jpg"))
                hasImage = true
            }
            let item = Item(id: id, url: url, text: text.map { String($0.prefix(4000)) }, hasImage: hasImage, savedAt: .now)
            try JSONEncoder().encode(item).write(to: dir.appendingPathComponent("share.json"))
            return true
        } catch {
            try? FileManager.default.removeItem(at: dir)
            return false
        }
    }

    /// The oldest waiting share from the last two days (older ones are thrown away), with its screenshot.
    static func next() -> (item: Item, image: UIImage?)? {
        guard let folder, let dirs = try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil) else { return nil }
        var waiting: [Item] = []
        for dir in dirs {
            guard let data = try? Data(contentsOf: dir.appendingPathComponent("share.json")),
                  let item = try? JSONDecoder().decode(Item.self, from: data),
                  item.savedAt > Date.now.addingTimeInterval(-2 * 86_400)
            else {
                try? FileManager.default.removeItem(at: dir)
                continue
            }
            waiting.append(item)
        }
        guard let first = waiting.min(by: { $0.savedAt < $1.savedAt }) else { return nil }
        let image = first.hasImage
            ? (try? Data(contentsOf: folder.appendingPathComponent(first.id).appendingPathComponent("image.jpg"))).flatMap(UIImage.init(data:))
            : nil
        return (first, image)
    }

    /// Done with a share (added or dismissed).
    static func remove(_ id: String) {
        guard let folder else { return }
        try? FileManager.default.removeItem(at: folder.appendingPathComponent(id, isDirectory: true))
    }
}

extension UIImage {
    /// A copy no larger than `maxSide` points on its longest side (receipts stay readable at 2000).
    func scaledForUpload(maxSide: CGFloat) -> UIImage {
        let longest = max(size.width, size.height)
        guard longest > maxSide else { return self }
        let scale = maxSide / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}
