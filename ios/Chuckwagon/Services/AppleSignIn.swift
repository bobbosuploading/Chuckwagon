import AuthenticationServices
import CryptoKit
import FirebaseAuth
import Foundation

/// Sign in with Apple, linked to the current (anonymous) Firebase user so plans carry over.
enum AppleSignIn {
    /// Random string Apple echoes back, so Firebase can check the sign-in is fresh.
    static func makeNonce(length: Int = 32) -> String {
        let chars = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        _ = SecRandomCopyBytes(kSecRandomDefault, length, &bytes)
        return String(bytes.map { chars[Int($0) % chars.count] })
    }

    static func sha256(_ input: String) -> String {
        SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    /// Finishes sign-in after Apple's sheet returns.
    /// Links Apple to the current account; if this Apple ID already has an account
    /// (for example after reinstalling), signs into that account instead.
    static func complete(_ authorization: ASAuthorization, nonce: String) async throws {
        guard let apple = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = apple.identityToken,
              let token = String(data: tokenData, encoding: .utf8) else {
            throw NSError(domain: "Chuckwagon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Apple didn't return a sign-in token."])
        }
        let credential = OAuthProvider.appleCredential(withIDToken: token, rawNonce: nonce, fullName: apple.fullName)
        if let user = Auth.auth().currentUser, user.isAnonymous {
            do {
                _ = try await user.link(with: credential)
                return
            } catch let error as NSError where error.code == AuthErrorCode.credentialAlreadyInUse.rawValue {
                let updated = error.userInfo[AuthErrorUserInfoUpdatedCredentialKey] as? AuthCredential ?? credential
                _ = try await Auth.auth().signIn(with: updated)
                return
            }
        }
        _ = try await Auth.auth().signIn(with: credential)
    }

    /// Signs out and starts a fresh anonymous session.
    static func signOut() async throws {
        try Auth.auth().signOut()
        _ = try await Auth.auth().signInAnonymously()
    }
}
