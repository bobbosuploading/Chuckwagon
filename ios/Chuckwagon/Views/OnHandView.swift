import SwiftUI

/// What the household has at home: proteins in the freezer, a bag of rice, half a bag of spinach.
/// Shared like the shopping list (same household), and read by "Cook from what I have" when
/// building a plan. Items marked "Use soon" start picked there.
struct OnHandView: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet with a Done button; false when pushed.
    var showsDone = false

    @State private var newItem = ""
    @State private var newNote = ""
    @State private var editing: HouseholdList.OnHandItem?
    @State private var message: String?
    @State private var scanning = false
    @FocusState private var adding: Bool

    private var groups: [(String, [HouseholdList.OnHandItem])] {
        let grouped = Dictionary(grouping: list.onHand) { $0.kind.isEmpty ? "Other" : $0.kind }
        return HouseholdList.onHandKinds.compactMap { kind in grouped[kind].map { (kind, $0) } }
    }

    var body: some View {
        List {
            Section {
                HStack {
                    TextField("Add food you have, like pork butt", text: $newItem)
                        .focused($adding)
                        .submitLabel(newItem.isEmpty ? .done : .next)
                        .onSubmit { addTyped() }
                    Button { scanning = true } label: {
                        Image(systemName: "barcode.viewfinder").font(.title2)
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Scan a barcode")
                }
                if !newItem.isEmpty {
                    HStack {
                        TextField("How much? Like 3 lb (optional)", text: $newNote)
                            .onSubmit { addTyped() }
                        Button { addTyped() } label: {
                            Image(systemName: "plus.circle.fill").font(.title2)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Add")
                    }
                }
            } footer: {
                if let message { Text(message) }
            }

            if list.loading && list.onHand.isEmpty {
                Section { ProgressView().frame(maxWidth: .infinity) }
            } else if list.onHand.isEmpty {
                Section {
                    Text("Keep track of what's in your fridge, freezer and pantry, and \"Cook from what I have\" can build meals around it. Type food above, scan a barcode, or tap \"Move to on hand\" on the shopping list after you shop.")
                        .font(Theme.body(.footnote))
                        .foregroundStyle(Theme.ink.opacity(0.65))
                }
            }

            ForEach(groups, id: \.0) { kind, items in
                Section(kind) {
                    ForEach(items) { row($0) }
                }
            }

            if !list.onHand.isEmpty {
                Section {
                    Text(list.isShared
                         ? "Shared with \(list.othersText). Tap the flame to mark food that needs cooking soon; plans that cook from what you have start with it picked. Swipe left when it's used up, or right to put it back on the shopping list."
                         : "Tap the flame to mark food that needs cooking soon; plans that cook from what you have start with it picked. Swipe left when it's used up, or right to put it back on the shopping list. Share your shopping list and this list comes along.")
                        .font(Theme.body(.footnote))
                        .foregroundStyle(Theme.ink.opacity(0.65))
                }
            }
        }
        .creamBackground()
        .scrollDismissesKeyboard(.immediately)
        .keyboardDoneButton()
        .font(Theme.body())
        .foregroundStyle(Theme.ink)
        .navigationTitle("On hand")
        .toolbar {
            if showsDone { Button("Done") { dismiss() } }
        }
        .sheet(isPresented: $scanning) { BarcodeScanView(toOnHand: true) }
        .sheet(item: $editing) { item in
            EditOnHandSheet(item: item)
                .presentationDetents([.medium, .large])
        }
    }

    private func row(_ item: HouseholdList.OnHandItem) -> some View {
        HStack(spacing: 12) {
            Button {
                editing = item
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.text)
                    if let detail = detail(item) {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button {
                list.setUseSoon(item, !item.useSoon)
            } label: {
                Image(systemName: item.useSoon ? "flame.fill" : "flame")
                    .font(.title3)
                    .foregroundStyle(item.useSoon ? Theme.red : Theme.ink.opacity(0.3))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(item.useSoon ? "Don't need to use \(item.text) soon" : "Use \(item.text) soon")
        }
        .swipeActions(edge: .trailing) {
            Button(role: .destructive) { list.deleteOnHand([item]) } label: { Label("Used up", systemImage: "trash") }
        }
        .swipeActions(edge: .leading) {
            Button {
                Task {
                    do {
                        try await list.restock(item)
                        message = "\(item.text) is on the shopping list."
                    } catch {
                        message = Backend.friendlyMessage(for: error)
                    }
                }
            } label: { Label("Buy more", systemImage: "cart.badge.plus") }
            .tint(Theme.sage)
        }
    }

    /// "3 lb · use soon · added by Sam"
    private func detail(_ item: HouseholdList.OnHandItem) -> String? {
        var parts: [String] = []
        if !item.note.isEmpty { parts.append(item.note) }
        if item.useSoon { parts.append("use soon") }
        if list.isShared, let who = list.name(for: item.addedBy) ?? (item.addedByName.isEmpty ? nil : item.addedByName) {
            parts.append("added by \(who)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func addTyped() {
        let text = newItem
        let note = newNote
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            adding = false
            return
        }
        newItem = ""
        newNote = ""
        adding = true
        Task {
            do {
                let added = try await list.addOnHand(text, note: note)
                message = added ? nil : "\(text.trimmingCharacters(in: .whitespaces)) is already on hand\(note.isEmpty ? "" : "; updated how much")."
            } catch {
                newItem = text
                newNote = note
                message = Backend.friendlyMessage(for: error)
            }
        }
    }
}

/// Change an on-hand item's name, amount, group or "use soon".
private struct EditOnHandSheet: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss
    let item: HouseholdList.OnHandItem
    @State private var text = ""
    @State private var note = ""
    @State private var kind = ""
    @State private var useSoon = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Food", text: $text)
                TextField("How much, like 3 lb or half a bag", text: $note)
                Picker("Kind", selection: $kind) {
                    ForEach(HouseholdList.onHandKinds, id: \.self) { Text($0).tag($0) }
                }
                Toggle("Use soon", isOn: $useSoon)
                Section {
                    Button("Used up (take it off)", role: .destructive) {
                        list.deleteOnHand([item])
                        dismiss()
                    }
                }
            }
            .creamBackground()
            .navigationTitle("On hand")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        list.editOnHand(item, text: text, note: note, kind: kind, useSoon: useSoon)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                text = item.text
                note = item.note
                kind = item.kind.isEmpty ? HouseholdList.guessKind(item.text) : item.kind
                useSoon = item.useSoon
            }
        }
    }
}
