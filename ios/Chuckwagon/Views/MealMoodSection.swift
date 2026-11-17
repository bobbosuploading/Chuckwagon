import SwiftUI

/// What the shopper feels like eating this trip, for the plan screen: quick-pick chips plus
/// their own words for every meal, and optionally a theme for each night ("Mexican night").
/// All optional; with nothing picked the planner works as before.
struct MealMood: Equatable {
    /// Quick picks offered as chips and in each night's menu.
    static let choices = [
        "Mexican", "Seafood", "Italian", "Asian", "BBQ", "Comfort food",
        "Soups & stews", "Breakfast for dinner", "Meatless", "International",
    ]
    /// Same limits as the planner (functions/src/plan.ts), which cuts anything longer.
    static let maxTextLength = 80

    var picked: Set<String> = []
    var text = ""
    var perNight = false
    /// One per meal, "" for any.
    var nights: [String] = []

    /// The mood for every meal, e.g. "Mexican, Seafood, something spicy", or nil with none.
    var theme: String? {
        var parts = Self.choices.filter { picked.contains($0) }
        let own = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !own.isEmpty { parts.append(own) }
        let joined = parts.joined(separator: ", ")
        return joined.isEmpty ? nil : String(joined.prefix(Self.maxTextLength))
    }

    /// A theme for each of `mealCount` meals ("" = any), or nil when per-night themes are off
    /// or none is set.
    func nightThemes(mealCount: Int) -> [String]? {
        guard perNight else { return nil }
        let list = (0..<mealCount).map { $0 < nights.count ? nights[$0] : "" }
        return list.contains(where: { !$0.isEmpty }) ? list : nil
    }

    mutating func setNight(_ index: Int, to theme: String) {
        if nights.count <= index { nights += Array(repeating: "", count: index + 1 - nights.count) }
        nights[index] = theme
    }
}

struct MealMoodSection: View {
    @Binding var mood: MealMood
    let mealCount: Int
    /// Saved meals take the first nights, so those nights get no theme.
    let includedNames: [String]

    var body: some View {
        Section {
            ChipFlow(spacing: 8) {
                ForEach(MealMood.choices, id: \.self) { choice in
                    chip(choice)
                }
            }
            .padding(.vertical, 4)
            TextField("Or say it your way, e.g. something spicy", text: $mood.text)
                .onChange(of: mood.text) { _, new in
                    if new.count > MealMood.maxTextLength { mood.text = String(new.prefix(MealMood.maxTextLength)) }
                }
            Toggle("Pick a theme for each night", isOn: $mood.perNight.animation())
            if mood.perNight {
                ForEach(0..<mealCount, id: \.self) { night in
                    nightRow(night)
                }
            }
        } header: {
            Text("In the mood for")
        } footer: {
            Text(footer)
        }
    }

    private var footer: String {
        if mood.theme == nil && mood.nightThemes(mealCount: mealCount) == nil {
            return "Optional. Pick what sounds good, like Mexican night or seafood, and we'll build those meals from what's on sale."
        }
        return "We'll build these meals from what's on sale. If the sales don't fit a theme well, we'll get as close as we can and tell you."
    }

    private func chip(_ choice: String) -> some View {
        let on = mood.picked.contains(choice)
        return Button {
            if on { mood.picked.remove(choice) } else { mood.picked.insert(choice) }
        } label: {
            Text(choice)
                .font(Theme.body(.subheadline, weight: on ? .semibold : .regular))
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .foregroundStyle(on ? Color.white : Theme.ink)
                .background(on ? Theme.red : Theme.cream, in: Capsule())
                .overlay(Capsule().stroke(on ? Theme.red : Theme.ink.opacity(0.2)))
        }
        .buttonStyle(.borderless)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    @ViewBuilder private func nightRow(_ night: Int) -> some View {
        if night < includedNames.count {
            LabeledContent("Meal \(night + 1)", value: includedNames[night])
                .foregroundStyle(Theme.ink.opacity(0.6))
        } else {
            Picker("Meal \(night + 1)", selection: Binding(
                get: { night < mood.nights.count ? mood.nights[night] : "" },
                set: { mood.setNight(night, to: $0) }
            )) {
                Text("Any").tag("")
                ForEach(MealMood.choices, id: \.self) { Text($0).tag($0) }
            }
        }
    }
}

/// Lays out chips left to right, wrapping onto new lines.
struct ChipFlow: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let rows = arrange(width: proposal.width ?? .infinity, subviews: subviews)
        let width = rows.map(\.width).max() ?? 0
        let height = rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1))
        return CGSize(width: width, height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var y = bounds.minY
        for row in arrange(width: bounds.width, subviews: subviews) {
            var x = bounds.minX
            for index in row.items {
                let size = subviews[index].sizeThatFits(.unspecified)
                subviews[index].place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
                x += size.width + spacing
            }
            y += row.height + spacing
        }
    }

    private struct Row {
        var items: [Int] = []
        var width: CGFloat = 0
        var height: CGFloat = 0
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> [Row] {
        var rows: [Row] = []
        var row = Row()
        for index in subviews.indices {
            let size = subviews[index].sizeThatFits(.unspecified)
            let needed = row.items.isEmpty ? size.width : row.width + spacing + size.width
            if needed > width, !row.items.isEmpty {
                rows.append(row)
                row = Row()
            }
            row.width = row.items.isEmpty ? size.width : row.width + spacing + size.width
            row.height = max(row.height, size.height)
            row.items.append(index)
        }
        if !row.items.isEmpty { rows.append(row) }
        return rows
    }
}
