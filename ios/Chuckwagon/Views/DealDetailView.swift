import SwiftUI

/// The whole deal, opened by tapping a deal card: a big ad picture and all the text the card cuts off.
struct DealDetailView: View {
    let deal: Deal
    let storeName: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    picture

                    VStack(alignment: .leading, spacing: 6) {
                        if let storeName {
                            Label(storeName, systemImage: "storefront.fill")
                                .font(Theme.body(.footnote, weight: .semibold))
                                .foregroundStyle(Theme.red)
                        }
                        Text(deal.name)
                            .font(Theme.title(24))
                            .foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true)
                        let details = [deal.brand, deal.size].compactMap { $0 }.filter { !$0.isEmpty }
                        if !details.isEmpty {
                            Text(details.joined(separator: " • "))
                                .font(Theme.body(.subheadline))
                                .foregroundStyle(Theme.ink.opacity(0.6))
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    price

                    if let promo = deal.promo, !promo.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("THE DEAL")
                                .font(.system(size: 12, weight: .heavy, design: .rounded))
                                .tracking(1.2)
                                .foregroundStyle(Theme.ink.opacity(0.5))
                            Text(promo)
                                .font(Theme.body(.body, weight: .medium))
                                .foregroundStyle(Theme.red)
                                .fixedSize(horizontal: false, vertical: true)
                                .textSelection(.enabled)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .card()
                    }

                    if let tip = deal.stockUp {
                        StockUpDetail(tip: tip)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                            .card()
                    }
                }
                .padding(20)
            }
            .background(Theme.cream.ignoresSafeArea())
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }

    private var picture: some View {
        AsyncImage(url: deal.imageUrl.flatMap(URL.init(string:))) { image in
            image.resizable().scaledToFit()
        } placeholder: {
            if deal.imageUrl == nil {
                Image(systemName: "basket")
                    .font(.system(size: 60))
                    .foregroundStyle(Theme.ink.opacity(0.2))
            } else {
                ProgressView()
            }
        }
        .frame(maxWidth: .infinity, minHeight: 200)
        .padding(12)
        .background(Color.white, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(alignment: .topLeading) {
            if deal.pctOff > 0 {
                SaleTag(pct: deal.pctOff).padding(8)
            }
        }
    }

    @ViewBuilder private var price: some View {
        if let sale = deal.salePrice {
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(sale.dollars + deal.perUnit)
                        .font(.system(.largeTitle, design: .rounded, weight: .heavy))
                        .foregroundStyle(Theme.red)
                    if let regular = deal.regularPrice {
                        Text("Reg. " + regular.dollars + deal.perUnit)
                            .font(Theme.body(.subheadline))
                            .strikethrough()
                            .foregroundStyle(Theme.ink.opacity(0.5))
                    }
                }
                if let savings = deal.savings, savings > 0 {
                    Text("You save \(savings.dollars)" + (deal.pctOff > 0 ? " (\(deal.pctOff)% off)" : ""))
                        .font(Theme.body(.footnote, weight: .semibold))
                        .foregroundStyle(Theme.sage)
                }
            }
        }
    }
}
