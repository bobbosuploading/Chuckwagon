import SwiftUI

/// "STOCK UP" tag on a deal card. Tap it for how much to buy and how to store it.
struct StockUpBadge: View {
    let tip: StockUp
    @State private var showing = false

    var body: some View {
        Button { showing = true } label: {
            Label(tip.isGreat ? "STOCK UP!" : "STOCK UP", systemImage: tip.symbol)
                .font(.system(size: 11, weight: .black, design: .rounded))
                .foregroundStyle(.white)
                .padding(.horizontal, 8).padding(.vertical, 4)
                .background(Theme.sage, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Shows how much to buy and how to store it")
        .popover(isPresented: $showing) {
            StockUpDetail(tip: tip)
                .padding(16)
                .frame(idealWidth: 300)
                .presentationCompactAdaptation(.popover)
        }
    }
}

/// The tip itself: why it's a stock-up price, how much to buy, and how to keep it.
struct StockUpDetail: View {
    let tip: StockUp

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(tip.isGreat ? "Great stock-up price" : "Good stock-up price", systemImage: tip.symbol)
                .font(Theme.body(.headline, weight: .bold))
                .foregroundStyle(Theme.sage)
            Text("\(tip.reason). \(tip.howMuch).")
                .font(Theme.body(.subheadline, weight: .semibold))
                .foregroundStyle(Theme.ink)
            Text(tip.storage)
                .font(Theme.body(.subheadline))
                .foregroundStyle(Theme.ink.opacity(0.75))
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// One-line tip under a grocery list item, with the storage advice beneath it.
struct StockUpNote: View {
    let tip: StockUp

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Label("Stock up: \(tip.keepLabel.lowercased()). Buy extra, \(tip.howMuch.prefix(1).lowercased() + tip.howMuch.dropFirst()).", systemImage: tip.symbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(Theme.sage)
            Text(tip.storage)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 2)
    }
}
