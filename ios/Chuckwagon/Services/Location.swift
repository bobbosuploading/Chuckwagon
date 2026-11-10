import CoreLocation
import Foundation

/// Turns a ZIP into map coordinates, or the phone's location into a ZIP.
/// Only the ZIP is ever sent to our servers, never the exact location.
@MainActor
final class Location: NSObject, CLLocationManagerDelegate {
    static let shared = Location()
    private let manager = CLLocationManager()
    private var continuation: CheckedContinuation<CLLocation, Error>?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
    }

    /// Center of a ZIP code (approximate).
    static func coordinates(forZip zip: String) async -> CLLocationCoordinate2D? {
        let places = try? await CLGeocoder().geocodeAddressString("\(zip), USA")
        return places?.first?.location?.coordinate
    }

    /// Asks once for location, then returns the ZIP and its coordinates.
    func currentZip() async throws -> (zip: String, coordinate: CLLocationCoordinate2D) {
        if manager.authorizationStatus == .notDetermined { manager.requestWhenInUseAuthorization() }
        let location = try await withCheckedThrowingContinuation { (c: CheckedContinuation<CLLocation, Error>) in
            continuation = c
            manager.requestLocation()
        }
        let place = try await CLGeocoder().reverseGeocodeLocation(location).first
        guard let zip = place?.postalCode else {
            throw NSError(domain: "Chuckwagon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't find a ZIP code for your location."])
        }
        return (zip, location.coordinate)
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        Task { @MainActor in
            continuation?.resume(returning: loc)
            continuation = nil
        }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in
            continuation?.resume(throwing: error)
            continuation = nil
        }
    }
}
