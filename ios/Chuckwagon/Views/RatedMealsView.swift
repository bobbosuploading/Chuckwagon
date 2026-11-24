import SwiftUI

/// Settings > Keepers, or Settings > Fed to the dogs: every meal on that list, newest first,
/// with a way to take each off.
struct RatedMealsView: View {
    enum Kind { case liked, disliked }
    let kind: Kind
    @Environment(MealRatings.self) private var ratings
    @State private var error: String?

    private typealias W = MealRatingWords

    private var names: [String] {
        (kind == .liked ? ratings.liked.map(\.name) : ratings.disliked).reversed()
    }
    private var title: String { kind == .liked ? W.likedList : W.dislikedList }
    private var undoLabel: String { kind == .liked ? "Remove" : "Undo" }

    var body: some View {
        List {
            if names.isEmpty {
                Section {
                    Text(ratings.loaded ? emptyText : "Loading…")
                        .font(Theme.body(.callout))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                }
            } else {
                Section {
                    ForEach(names, id: \.self) { name in
                        HStack {
                            Label(name, systemImage: kind == .liked ? W.likeIcon : W.dislikeIcon)
                                .labelStyle(RatedLabelStyle(color: kind == .liked ? W.likeColor : W.dislikeColor))
                            Spacer()
                            if ratings.saving == name {
                                ProgressView()
                            } else {
                                Button(undoLabel) { undo(name) }
                                    .buttonStyle(.borderless)
                                    .disabled(ratings.saving != nil)
                                    .accessibilityLabel(kind == .liked ? "Unlike \(name)" : "Like again: \(name)")
                            }
                        }
                        .swipeActions {
                            Button { undo(name) } label: {
                                Label(kind == .liked ? W.likeUndo : W.dislikeUndo,
                                      systemImage: kind == .liked ? W.likeUndoIcon : W.dislikeUndoIcon)
                            }
                            .tint(kind == .liked ? Theme.ink.opacity(0.5) : Theme.sage)
                        }
                    }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.red)
                    } else {
                        Text(footerText)
                    }
                }
            }
        }
        .creamBackground()
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await ratings.load(force: true) }
    }

    private var emptyText: String {
        kind == .liked
            ? "No keepers yet. In a plan, swipe right on a meal you'd cook again (or open it) and tap \(W.like). Keepers show up first when you pick saved meals for a new plan."
            : "Nothing fed to the dogs yet. In a plan, swipe left on a meal you don't like (or open it) and tap \(W.dislike), and new plans will stop suggesting it."
    }

    private var footerText: String {
        kind == .liked
            ? "\(W.likeHint) We keep your last \(MealRatings.maxLiked)."
            : "New plans skip these meals and ones like them. Tap Undo to see a meal again. We keep your last \(MealRatings.maxDisliked)."
    }

    private func undo(_ name: String) {
        Task {
            error = kind == .liked ? await ratings.unlike(name) : await ratings.setDisliked(name, false)
        }
    }
}

/// A label whose icon is tinted, with the title in the normal text color.
struct RatedLabelStyle: LabelStyle {
    let color: Color
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 8) {
            configuration.icon.foregroundStyle(color)
            configuration.title.foregroundStyle(Theme.ink)
        }
    }
}
