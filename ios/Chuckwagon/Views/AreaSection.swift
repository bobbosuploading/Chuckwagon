import SwiftUI

/// "Your area": ZIP code or current location. Stores are filtered to this area.
struct AreaSection: View {
    @Environment(Preferences.self) private var prefs
    @State private var zipText = ""
    @State private var working = false
    @State private var message: String?

    var body: some View {
        Section {
            HStack {
                TextField("ZIP code", text: $zipText)
                    .keyboardType(.numberPad)
                    .onSubmit { Task { await setZip(zipText) } }
                if zipText != prefs.zip && zipText.count == 5 {
                    Button("Save") { Task { await setZip(zipText) } }
                        .disabled(working)
                }
            }
            Button {
                Task { await useMyLocation() }
            } label: {
                Label("Use my location", systemImage: "location.fill")
            }
            .disabled(working)
            if let message {
                Text(message).font(Theme.body(.footnote)).foregroundStyle(Theme.ink.opacity(0.7))
            }
        } header: {
            Text("Your area")
        } footer: {
            Text("We only keep your ZIP code, never your exact location.")
        }
        .onAppear { zipText = prefs.zip }
    }

    private func useMyLocation() async {
        working = true
        defer { working = false }
        do {
            let found = try await Location.shared.currentZip()
            zipText = found.zip
            await apply(zip: found.zip, lat: found.coordinate.latitude, lng: found.coordinate.longitude)
        } catch {
            message = "Couldn't get your location. You can type your ZIP instead."
        }
    }

    private func setZip(_ zip: String) async {
        let zip = zip.trimmingCharacters(in: .whitespaces)
        guard zip.count == 5, zip.allSatisfy(\.isNumber) else {
            message = "Please enter a 5-digit ZIP code."
            return
        }
        working = true
        defer { working = false }
        let coord = await Location.coordinates(forZip: zip)
        await apply(zip: zip, lat: coord?.latitude, lng: coord?.longitude)
    }

    private func apply(zip: String, lat: Double?, lng: Double?) async {
        prefs.zip = zip
        prefs.latitude = lat ?? 0
        prefs.longitude = lng ?? 0
        let status = try? await Backend.registerArea(zip: zip)
        switch status {
        case "ready": message = nil
        case "waitlist": message = "Chuckwagon isn't in your area yet during testing. We've added you to the list."
        default: message = "Thanks! Deals near \(zip) arrive with our next morning update (Monday, Wednesday or Friday)."
        }
    }
}
