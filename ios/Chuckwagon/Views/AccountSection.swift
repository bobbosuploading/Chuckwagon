import AuthenticationServices
import FirebaseAuth
import SwiftUI

/// Settings > Account: Sign in with Apple, premium status, and tester codes.
struct AccountSection: View {
    @State private var user = Auth.auth().currentUser
    @State private var premium = false
    @State private var krogerConnected = false
    @State private var nonce = ""
    @State private var code = ""
    @State private var message: String?
    @State private var working = false

    private var signedInWithApple: Bool {
        user?.providerData.contains { $0.providerID == "apple.com" } ?? false
    }

    var body: some View {
        Section {
            if signedInWithApple {
                LabeledContent("Signed in", value: user?.email ?? "Apple ID")
                Button("Sign out", role: .destructive) {
                    Task {
                        try? await AppleSignIn.signOut()
                        await refresh()
                    }
                }
            } else {
                SignInWithAppleButton(.signIn) { request in
                    nonce = AppleSignIn.makeNonce()
                    request.requestedScopes = [.email]
                    request.nonce = AppleSignIn.sha256(nonce)
                } onCompletion: { result in
                    Task {
                        switch result {
                        case .success(let auth):
                            do {
                                try await AppleSignIn.complete(auth, nonce: nonce)
                                message = "Signed in. Your plans now follow you to any phone."
                            } catch {
                                message = error.localizedDescription
                            }
                        case .failure(let error):
                            if (error as? ASAuthorizationError)?.code != .canceled { message = error.localizedDescription }
                        }
                        await refresh()
                    }
                }
                .signInWithAppleButtonStyle(.black)
                .frame(height: 46)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            }

            HStack {
                Text("Plan")
                Spacer()
                Text(premium ? "Premium" : "Free")
                    .font(Theme.body(.subheadline, weight: .bold))
                    .foregroundStyle(premium ? Theme.red : Theme.ink.opacity(0.6))
            }

            if !premium {
                HStack {
                    TextField("Tester code", text: $code)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    Button("Redeem") {
                        Task { await redeem() }
                    }
                    .disabled(code.trimmingCharacters(in: .whitespaces).isEmpty || working)
                }
            }

            if krogerConnected {
                HStack {
                    Text("Kroger account")
                    Spacer()
                    Button("Disconnect", role: .destructive) {
                        Task {
                            try? await SendToCart.disconnectKroger()
                            await refresh()
                        }
                    }
                    .buttonStyle(.borderless)
                }
            }

            if let message {
                Text(message).font(Theme.body(.footnote)).foregroundStyle(Theme.ink.opacity(0.7))
            }
        } header: {
            Text("Account")
        } footer: {
            if let uid = user?.uid {
                Text("Account ID: \(uid)")
                    .textSelection(.enabled)
            }
        }
        .task { await refresh() }
    }

    private func refresh() async {
        user = Auth.auth().currentUser
        premium = (try? await Backend.isPremium()) ?? false
        krogerConnected = (try? await Backend.isKrogerConnected()) ?? false
    }

    private func redeem() async {
        working = true
        defer { working = false }
        do {
            try await Backend.redeemCode(code.trimmingCharacters(in: .whitespaces))
            message = "Premium unlocked. Enjoy Chef's pick!"
            code = ""
        } catch {
            message = error.localizedDescription
        }
        await refresh()
    }
}
