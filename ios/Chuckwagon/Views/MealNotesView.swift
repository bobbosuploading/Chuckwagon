import SwiftUI

/// The words for the shopper's own notes on meals, in one place so they're easy to change.
enum MealNoteWords {
    static let title = "Cook's notes"
    static let icon = "pencil.line"
    static let add = "Add a note"
    static let edit = "Edit note"
    static let placeholder = "What did you change to make it better? For example: used twice the garlic, added a can of green chiles, 10 more minutes in the oven."
    static let hint = "Only you see your notes. They show up on this meal in every plan, and new plans try to cook it your way."
}

/// A meal's note in one or two lines, under its name in a plan or a list. Shows nothing without a note.
struct MealNoteLine: View {
    let name: String
    var lines = 2
    @Environment(MealRatings.self) private var ratings

    var body: some View {
        if let note = ratings.note(for: name) {
            Label(note, systemImage: MealNoteWords.icon)
                .font(.caption)
                .foregroundStyle(Theme.ink.opacity(0.75))
                .lineLimit(lines)
                .accessibilityLabel("Your note: \(note)")
        }
    }
}

/// The "Cook's notes" section in a recipe: the shopper's note, and a button to add or edit it.
struct MealNoteSection: View {
    let name: String
    @Environment(MealRatings.self) private var ratings
    @State private var editing = false

    var body: some View {
        let note = ratings.note(for: name)
        Section {
            if let note {
                Text(note)
                    .font(Theme.body())
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
            }
            Button {
                editing = true
            } label: {
                Label(note == nil ? MealNoteWords.add : MealNoteWords.edit,
                      systemImage: note == nil ? "plus.circle" : MealNoteWords.icon)
            }
        } header: {
            Text(MealNoteWords.title)
        } footer: {
            Text(MealNoteWords.hint)
        }
        .sheet(isPresented: $editing) {
            MealNoteEditor(name: name)
        }
    }
}

/// Writes or changes the note on a meal. Saving an empty note deletes it.
struct MealNoteEditor: View {
    let name: String
    @Environment(MealRatings.self) private var ratings
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @FocusState private var focused: Bool

    private var hadNote: Bool { ratings.note(for: name) != nil }
    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ZStack(alignment: .topLeading) {
                        if text.isEmpty {
                            Text(MealNoteWords.placeholder)
                                .foregroundStyle(Theme.ink.opacity(0.4))
                                .padding(.top, 8).padding(.leading, 5)
                                .allowsHitTesting(false)
                        }
                        TextEditor(text: $text)
                            .focused($focused)
                            .frame(minHeight: 160)
                            .scrollContentBackground(.hidden)
                    }
                    .font(Theme.body())
                } header: {
                    Text(name)
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.red)
                    } else {
                        Text("\(text.count) of \(MealRatings.maxNoteLength) characters. \(MealNoteWords.hint)")
                    }
                }
                if hadNote {
                    Section {
                        Button("Delete note", role: .destructive) { save("") }
                            .disabled(ratings.savingNote != nil)
                    }
                }
            }
            .creamBackground()
            .navigationTitle(MealNoteWords.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if ratings.savingNote == name {
                        ProgressView()
                    } else {
                        Button("Save") { save(trimmed) }
                            .bold()
                            .disabled(ratings.savingNote != nil || (trimmed.isEmpty && !hadNote))
                    }
                }
            }
            .onChange(of: text) { _, new in
                if new.count > MealRatings.maxNoteLength { text = String(new.prefix(MealRatings.maxNoteLength)) }
            }
            .onAppear {
                text = ratings.note(for: name) ?? ""
                focused = true
            }
        }
        .presentationDetents([.medium, .large])
        .interactiveDismissDisabled(trimmed != (ratings.note(for: name) ?? ""))
    }

    private func save(_ note: String) {
        Task {
            if let message = await ratings.setNote(name, note) {
                error = message
            } else {
                dismiss()
            }
        }
    }
}

/// Settings > Cook's notes: every meal the shopper wrote a note on, newest first, to read, edit or delete.
struct MealNotesView: View {
    @Environment(MealRatings.self) private var ratings
    @State private var editing: MealNote?
    @State private var error: String?

    var body: some View {
        List {
            if ratings.notes.isEmpty {
                Section {
                    Text(ratings.loaded
                         ? "No notes yet. Open any meal in a plan and tap \"\(MealNoteWords.add)\" under \(MealNoteWords.title) to remember what you changed to make it better."
                         : "Loading…")
                        .font(Theme.body(.callout))
                        .foregroundStyle(Theme.ink.opacity(0.7))
                }
            } else {
                Section {
                    ForEach(ratings.notes.reversed(), id: \.self) { item in
                        Button { editing = item } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.name)
                                    .font(Theme.body(.body, weight: .semibold))
                                    .foregroundStyle(Theme.ink)
                                Text(item.note)
                                    .font(Theme.body(.footnote))
                                    .foregroundStyle(Theme.ink.opacity(0.7))
                                    .lineLimit(3)
                            }
                        }
                        .swipeActions {
                            Button(role: .destructive) { delete(item) } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                } footer: {
                    if let error {
                        Text(error).foregroundStyle(Theme.red)
                    } else {
                        Text("\(MealNoteWords.hint) Tap one to edit it. We keep your last \(MealRatings.maxNotes).")
                    }
                }
            }
        }
        .creamBackground()
        .navigationTitle(MealNoteWords.title)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $editing) { MealNoteEditor(name: $0.name) }
        .task { await ratings.load(force: true) }
    }

    private func delete(_ item: MealNote) {
        Task { error = await ratings.setNote(item.name, "") }
    }
}

extension MealNote: Identifiable {
    var id: String { MealRatings.key(name) }
}
