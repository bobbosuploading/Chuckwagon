import SwiftUI

/// Chuckwagon's warm, ranch-kitchen look.
enum Theme {
    static let red = Color(red: 0.71, green: 0.22, blue: 0.16)        // chuckwagon red
    static let mustard = Color(red: 0.89, green: 0.64, blue: 0.17)    // sale-tag yellow
    static let cream = Color(red: 0.98, green: 0.96, blue: 0.91)      // page background
    static let card = Color.white
    static let ink = Color(red: 0.24, green: 0.17, blue: 0.12)        // dark brown text
    static let sage = Color(red: 0.42, green: 0.53, blue: 0.38)       // "you saved" green

    static func title(_ size: CGFloat) -> Font { .system(size: size, weight: .heavy, design: .serif) }
    static func body(_ style: Font.TextStyle = .body, weight: Font.Weight = .regular) -> Font {
        .system(style, design: .rounded, weight: weight)
    }
}

extension Color {
    static let chuckRed = Theme.red
}

/// Soft white card with a gentle shadow.
struct CardStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(Theme.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(color: Theme.ink.opacity(0.08), radius: 8, y: 3)
    }
}

extension View {
    func card() -> some View { modifier(CardStyle()) }

    /// Cream background for Lists and Forms.
    func creamBackground() -> some View {
        scrollContentBackground(.hidden).background(Theme.cream.ignoresSafeArea())
    }
}

/// The big red pill button used at the bottom of screens.
struct BigButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var enabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.body(.headline, weight: .bold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .background(enabled ? Theme.red : Theme.red.opacity(0.4), in: Capsule())
            .shadow(color: Theme.red.opacity(0.35), radius: 10, y: 4)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
    }
}

/// Mustard "% OFF" tag.
struct SaleTag: View {
    let pct: Int
    var body: some View {
        Text("\(pct)% OFF")
            .font(.system(size: 12, weight: .black, design: .rounded))
            .foregroundStyle(Theme.ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Theme.mustard, in: Capsule())
    }
}
