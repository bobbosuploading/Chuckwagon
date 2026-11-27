import AuthenticationServices
import SwiftUI
import UIKit

/// The household's shared shopping list. Everyone in the household sees the same list, live:
/// add an item or check one off and it changes on the other phones too.
struct SharedListView: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss
    /// Shown as a sheet with a Done button; false when pushed or embedded.
    var showsDone = true

    @State private var newItem = ""
    @State private var editing: HouseholdList.Item?
    @State private var message: String?
    @State private var scanning = false
    @FocusState private var adding: Bool

    private var unchecked: [HouseholdList.Item] { list.items.filter { !$0.checked } }
    private var checked: [HouseholdList.Item] { list.items.filter(\.checked) }

    /// Unchecked items by aisle. Items typed in by hand (no aisle) come first.
    private var aisles: [(String, [HouseholdList.Item])] {
        let grouped = Dictionary(grouping: unchecked) { $0.aisle }
        func rank(_ aisle: String) -> Int {
            aisle.isEmpty ? -1 : (HouseholdList.aisleOrder.firstIndex(of: aisle) ?? HouseholdList.aisleOrder.count)
        }
        return grouped.sorted { (rank($0.key), $0.key) < (rank($1.key), $1.key) }.map { ($0.key, $0.value) }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack {
                        TextField("Add an item, like milk or paper towels", text: $newItem)
                            .focused($adding)
                            .submitLabel(newItem.isEmpty ? .done : .next)
                            .onSubmit { addTyped() }
                        Button { addTyped() } label: {
                            Image(systemName: "plus.circle.fill").font(.title2)
                        }
                        .buttonStyle(.borderless)
                        .disabled(newItem.trimmingCharacters(in: .whitespaces).isEmpty)
                        .accessibilityLabel("Add")
                        Button { scanning = true } label: {
                            Image(systemName: "barcode.viewfinder").font(.title2)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Scan a barcode")
                    }
                } footer: {
                    if let message { Text(message) }
                }

                if list.loading && list.items.isEmpty {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                } else if list.items.isEmpty {
                    Section {
                        Text("Nothing on the list yet. Type an item above, tap the barcode button to scan something you always buy, or open a meal plan and tap \"Add to shopping list\".")
                            .font(Theme.body(.footnote))
                            .foregroundStyle(Theme.ink.opacity(0.65))
                    }
                }

                ForEach(aisles, id: \.0) { aisle, items in
                    Section(aisle.isEmpty ? "To buy" : aisle) {
                        ForEach(items) { row($0) }
                    }
                }

                if !checked.isEmpty {
                    Section {
                        ForEach(checked) { row($0) }
                    } header: {
                        HStack {
                            Text("In the cart")
                            Spacer()
                            Button("Clear") { list.clearChecked() }
                                .font(Theme.body(.caption, weight: .bold))
                        }
                    }
                }

                HouseholdSection()
            }
            .creamBackground()
            .scrollDismissesKeyboard(.immediately)
            .keyboardDoneButton()
            .keepsScreenAwake()
            .font(Theme.body())
            .foregroundStyle(Theme.ink)
            .navigationTitle("Shopping list")
            .toolbar {
                if showsDone { Button("Done") { dismiss() } }
            }
            .sheet(isPresented: $scanning) { BarcodeScanView() }
            .sheet(item: $editing) { item in
                EditItemSheet(item: item)
                    .presentationDetents([.medium])
            }
        }
    }

    private func row(_ item: HouseholdList.Item) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Button {
                adding = false
                list.setChecked(item, !item.checked)
            } label: {
                Image(systemName: item.checked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(item.checked ? Theme.sage : Theme.ink.opacity(0.35))
                    .font(.title3)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(item.checked ? "Uncheck \(item.text)" : "Check off \(item.text)")

            Button {
                editing = item
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.text)
                        .strikethrough(item.checked)
                        .foregroundStyle(item.checked ? .secondary : .primary)
                    if let detail = detail(item) {
                        Text(detail).font(.caption).foregroundStyle(.secondary)
                    }
                    if let tip = item.stockUp, !item.checked {
                        StockUpNote(tip: tip)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .swipeActions {
            Button(role: .destructive) { list.delete([item]) } label: { Label("Delete", systemImage: "trash") }
        }
    }

    /// "2 lb · for Chicken tacos · at H-E-B · added by Sam"
    private func detail(_ item: HouseholdList.Item) -> String? {
        var parts: [String] = []
        if !item.note.isEmpty { parts.append(item.note) }
        if !item.forMeals.isEmpty { parts.append("for \(ListFormatter.localizedString(byJoining: item.forMeals))") }
        if !item.storeName.isEmpty { parts.append("at \(item.storeName)") }
        if list.isShared {
            if item.checked, let who = list.name(for: item.checkedBy) {
                parts.append("checked off by \(who)")
            } else if let who = list.name(for: item.addedBy) ?? (item.addedByName.isEmpty ? nil : item.addedByName) {
                parts.append("added by \(who)")
            }
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private func addTyped() {
        let text = newItem
        // Return on an empty box puts the keyboard away; with an item it adds it and stays
        // ready for the next one.
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            adding = false
            return
        }
        newItem = ""
        adding = true
        Task {
            do {
                let added = try await list.add(text)
                message = added ? nil : "\(text.trimmingCharacters(in: .whitespaces)) is already on the list."
            } catch {
                newItem = text
                message = Backend.friendlyMessage(for: error)
            }
        }
    }

}

/// Change an item's name or note ("2 lb", "the big jar").
private struct EditItemSheet: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss
    let item: HouseholdList.Item
    @State private var text = ""
    @State private var note = ""

    var body: some View {
        NavigationStack {
            Form {
                TextField("Item", text: $text)
                TextField("Note, like 2 lb or the big jar", text: $note)
                Section {
                    Button("Delete", role: .destructive) {
                        list.delete([item])
                        dismiss()
                    }
                }
            }
            .creamBackground()
            .navigationTitle("Edit item")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        list.edit(item, text: text, note: note)
                        dismiss()
                    }
                    .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                text = item.text
                note = item.note
            }
        }
    }
}

/// Who shares the list, and inviting someone (a spouse, a roommate) by link.
private struct HouseholdSection: View {
    @Environment(HouseholdList.self) private var list
    @State private var inviteURL: URL?
    @State private var working = false
    @State private var error: String?
    @State private var confirmingLeave = false
    @State private var signedIn = false

    var body: some View {
        @Bindable var list = list
        Section {
            if list.isShared {
                Label("Shared with \(list.othersText)", systemImage: "person.2.fill")
                    .foregroundStyle(Theme.ink)
            }
            TextField("Your first name (the others see it)", text: $list.myName)
                .textContentType(.givenName)

            if !signedIn {
                AppleSignInButton { signedIn = list.signedInWithApple }
                Text("Sign in with Apple to share your list, so it stays with you on any phone.")
                    .font(Theme.body(.footnote))
                    .foregroundStyle(Theme.ink.opacity(0.65))
            } else if let inviteURL {
                ShareLink(item: inviteURL,
                          subject: Text("Join my Chuckwagon shopping list"),
                          message: Text("Join my shopping list on Chuckwagon so we can both add things and check them off:")) {
                    Label("Send the invite", systemImage: "square.and.arrow.up")
                }
                Button {
                    UIPasteboard.general.url = inviteURL
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
            } else {
                Button {
                    Task { await makeInvite() }
                } label: {
                    HStack {
                        Label(list.isShared ? "Invite someone else" : "Share this list", systemImage: "person.badge.plus")
                        if working { Spacer(); ProgressView() }
                    }
                }
                .disabled(working)
            }

            if let error {
                Text(error).font(Theme.body(.footnote)).foregroundStyle(Theme.red)
            }

            if list.isShared {
                Button("Stop sharing with \(list.othersText)", role: .destructive) { confirmingLeave = true }
            }
        } header: {
            Text("Household")
        } footer: {
            Text(inviteURL != nil
                 ? "Anyone with this link can join your list for the next 7 days. They need Chuckwagon and to sign in with Apple."
                 : "Send your spouse or family a link. Once they join, you both see one list, and anything either of you adds or checks off shows up on both phones.")
        }
        .onAppear { signedIn = list.signedInWithApple }
        .confirmationDialog("Stop sharing?", isPresented: $confirmingLeave, titleVisibility: .visible) {
            Button("Stop sharing", role: .destructive) { Task { await leave() } }
        } message: {
            Text("You'll get an empty list of your own. \(list.othersText) keep the shared list.")
        }
    }

    private func makeInvite() async {
        working = true
        defer { working = false }
        do {
            inviteURL = try await list.inviteLink()
            error = nil
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }

    private func leave() async {
        do {
            try await list.leave()
            inviteURL = nil
        } catch {
            self.error = Backend.friendlyMessage(for: error)
        }
    }
}

/// Sign in with Apple, linked to the current account (see AppleSignIn).
struct AppleSignInButton: View {
    var onSignedIn: () -> Void
    @State private var nonce = ""
    @State private var error: String?

    var body: some View {
        SignInWithAppleButton(.signIn) { request in
            nonce = AppleSignIn.makeNonce()
            request.requestedScopes = [.email]
            request.nonce = AppleSignIn.sha256(nonce)
        } onCompletion: { result in
            Task {
                switch result {
                case .success(let auth):
                    do { try await AppleSignIn.complete(auth, nonce: nonce) } catch { self.error = error.localizedDescription }
                case .failure(let error):
                    if (error as? ASAuthorizationError)?.code != .canceled { self.error = error.localizedDescription }
                }
                onSignedIn()
            }
        }
        .signInWithAppleButtonStyle(.black)
        .frame(height: 46)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        if let error {
            Text(error).font(Theme.body(.footnote)).foregroundStyle(Theme.red)
        }
    }
}

/// Opened from an invite link: "Join Sam's shopping list?"
struct JoinHouseholdView: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss
    let code: String

    @State private var fromName = ""
    @State private var loading = true
    @State private var problem: String?
    @State private var joining = false
    @State private var joined = false
    @State private var signedIn = false

    var body: some View {
        if joined {
            SharedListView()
        } else {
            @Bindable var list = list
            NavigationStack {
                Form {
                    if loading {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if let problem {
                        Section {
                            Label(problem, systemImage: "exclamationmark.triangle")
                        }
                    } else {
                        Section {
                            Text(fromName.isEmpty ? "Join this shopping list?" : "Join \(fromName)'s shopping list?")
                                .font(Theme.title(24))
                            Text("You'll share one grocery list. Anything either of you adds or checks off shows up on both phones.")
                                .font(Theme.body(.subheadline))
                                .foregroundStyle(Theme.ink.opacity(0.7))
                            if list.isShared {
                                Text("You'll leave the list you share with \(list.othersText).")
                                    .font(Theme.body(.footnote, weight: .semibold))
                                    .foregroundStyle(Theme.red)
                            } else if list.uncheckedCount > 0 {
                                Text("The \(list.uncheckedCount) \(list.uncheckedCount == 1 ? "item" : "items") on your list now will come with you.")
                                    .font(Theme.body(.footnote))
                                    .foregroundStyle(Theme.ink.opacity(0.7))
                            }
                        }
                        Section {
                            TextField("Your first name (the others see it)", text: $list.myName)
                                .textContentType(.givenName)
                            if !signedIn {
                                AppleSignInButton { signedIn = list.signedInWithApple }
                                Text("Sign in with Apple first, so the shared list stays with you on any phone.")
                                    .font(Theme.body(.footnote))
                                    .foregroundStyle(Theme.ink.opacity(0.65))
                            }
                        }
                        Section {
                            Button {
                                Task { await join() }
                            } label: {
                                HStack {
                                    Text("Join the list").font(Theme.body(.headline, weight: .bold))
                                    if joining { Spacer(); ProgressView() }
                                }
                            }
                            .disabled(!signedIn || joining)
                        }
                    }
                }
                .creamBackground()
                .scrollDismissesKeyboard(.interactively)
                .keyboardDoneButton()
                .navigationTitle("Shared shopping list")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { Button("Not now") { dismiss() } }
                .task { await load() }
            }
        }
    }

    private func load() async {
        signedIn = list.signedInWithApple
        do {
            fromName = try await list.inviteInfo(code: code).fromName
        } catch {
            problem = Backend.friendlyMessage(for: error)
        }
        loading = false
    }

    private func join() async {
        joining = true
        defer { joining = false }
        do {
            try await list.join(code: code)
            joined = true
        } catch {
            problem = Backend.friendlyMessage(for: error)
        }
    }
}

/// On a plan's grocery list: copies the items still to buy onto the household's shopping list.
struct AddPlanToListSection: View {
    @Environment(HouseholdList.self) private var list
    let plan: MealPlan
    @State private var working = false
    @State private var result: String?
    @State private var showingList = false

    private var left: Int { plan.groceryList.filter { !$0.checked }.count }

    var body: some View {
        Section {
            Button {
                Task { await add() }
            } label: {
                HStack {
                    Label("Add to shopping list", systemImage: "checklist")
                    Spacer()
                    if working { ProgressView() } else { Text("\(left) items").font(.caption).foregroundStyle(.secondary) }
                }
            }
            .disabled(working || left == 0)
            if let result {
                Button(result) { showingList = true }
                    .font(Theme.body(.footnote))
            }
        } footer: {
            Text(list.isShared
                 ? "Puts these items on the list you share with \(list.othersText). Items you check off here, and items already on the list, are left out."
                 : "Puts these items on your shopping list, where you can add anything else you need. You can share that list with your household.")
        }
        .sheet(isPresented: $showingList) { SharedListView() }
    }

    private func add() async {
        working = true
        defer { working = false }
        do {
            let added = try await list.add(plan: plan)
            result = added == 0
                ? "Everything's already on your shopping list. Open the list"
                : "Added \(added) \(added == 1 ? "item" : "items"). Open the list"
        } catch {
            result = Backend.friendlyMessage(for: error)
        }
    }
}
