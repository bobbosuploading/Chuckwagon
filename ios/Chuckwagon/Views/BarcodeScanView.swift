import FirebaseFunctions
import PhotosUI
import SwiftUI
import UIKit
import Vision
import VisionKit

/// Scan a product's barcode (or pick a photo of one) to put that exact product on the shopping
/// list, brand and size included. The name comes from free product databases (barcodeProduct in
/// functions/src/barcodes.ts). If none of them know it, the shopper types the name, and this
/// phone remembers it for the next scan.
struct BarcodeScanView: View {
    @Environment(HouseholdList.self) private var list
    @Environment(\.dismiss) private var dismiss

    private enum Stage: Equatable {
        case scanning
        case lookingUp(String)
        case found(String)
        case notFound(String)
    }

    @State private var stage = Stage.scanning
    @State private var name = ""
    @State private var note = ""
    @State private var photo: PhotosPickerItem?
    @State private var problem: String?
    @State private var adding = false
    @State private var added: [String] = []
    @State private var typedCode = ""

    private var cameraWorks: Bool { DataScannerViewController.isSupported && DataScannerViewController.isAvailable }

    var body: some View {
        NavigationStack {
            Group {
                switch stage {
                case .scanning: scanner
                case .lookingUp: ProgressView("Looking it up…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .found(let code), .notFound(let code): result(code)
                }
            }
            .background(Theme.cream.ignoresSafeArea())
            .navigationTitle("Scan a barcode")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .onChange(of: photo) { _, item in
                guard let item else { return }
                photo = nil
                Task { await readPhoto(item) }
            }
        }
    }

    // MARK: Scanning

    private var scanner: some View {
        VStack(spacing: 14) {
            if cameraWorks {
                BarcodeCamera(onCode: { code in Task { await lookUp(code) } },
                              onProblem: { problem = $0 })
                    .frame(minHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                    .overlay(alignment: .bottom) {
                        Text("Point at the barcode")
                            .font(Theme.body(.footnote, weight: .semibold))
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.ultraThinMaterial, in: Capsule())
                            .padding(12)
                    }
            } else {
                ContentUnavailableView("Camera not available", systemImage: "barcode.viewfinder",
                                       description: Text("Pick a photo of the barcode instead."))
            }
            if let problem {
                Text(problem).font(Theme.body(.footnote)).foregroundStyle(Theme.red).multilineTextAlignment(.center)
            }
            if !added.isEmpty {
                Label("Added \(added.last ?? "")", systemImage: "checkmark.circle.fill")
                    .font(Theme.body(.footnote, weight: .semibold))
                    .foregroundStyle(Theme.sage)
            }
            HStack {
                TextField("Or type the numbers under the barcode", text: $typedCode)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                Button("Look up") {
                    let code = typedCode
                    typedCode = ""
                    Task { await lookUp(code) }
                }
                .disabled(!(8...14).contains(typedCode.filter(\.isNumber).count))
            }
            PhotosPicker(selection: $photo, matching: .images) {
                Label("Use a photo of a barcode", systemImage: "photo")
            }
            .buttonStyle(BigButtonStyle(outlined: true))
        }
        .padding(16)
    }

    // MARK: Result

    private func result(_ code: String) -> some View {
        Form {
            Section {
                if case .notFound = stage {
                    Text("We couldn't find this barcode. Type what it is, and this phone will remember it next time.")
                        .font(Theme.body(.subheadline))
                }
                TextField("What is it? Like Weiman cooktop cleaner, 12 oz", text: $name, axis: .vertical)
                    .font(Theme.body(.headline))
                TextField("Note (optional)", text: $note)
            } header: {
                Text("Barcode \(code)")
            } footer: {
                Text("Change the name if it isn't quite right. The barcode stays with the item so you get the same one next time.")
            }
            if let problem {
                Text(problem).foregroundStyle(Theme.red)
            }
            Section {
                Button {
                    Task { await add(code) }
                } label: {
                    HStack {
                        Text("Add to shopping list").font(Theme.body(.headline, weight: .bold))
                        if adding { Spacer(); ProgressView() }
                    }
                }
                .disabled(adding || name.trimmingCharacters(in: .whitespaces).isEmpty)
                Button("Scan another instead") { reset() }
            }
        }
        .creamBackground()
    }

    // MARK: Work

    private func lookUp(_ raw: String) async {
        let code = raw.filter(\.isNumber)
        guard stage == .scanning, (8...14).contains(code.count) else { return }
        problem = nil
        stage = .lookingUp(code)
        note = ""
        if let remembered = BarcodeNames.name(for: code) {
            name = remembered
            stage = .found(code)
            return
        }
        do {
            let result = try await Functions.functions().httpsCallable("barcodeProduct").call(["code": code])
            let data = result.data as? [String: Any]
            name = data?["name"] as? String ?? ""
            stage = (data?["found"] as? Bool ?? false) && !name.isEmpty ? .found(code) : .notFound(code)
        } catch {
            // Offline or a limit: let them type it rather than lose the scan.
            name = ""
            problem = Backend.friendlyMessage(for: error)
            stage = .notFound(code)
        }
    }

    private func add(_ code: String) async {
        adding = true
        defer { adding = false }
        let text = name.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            let isNew = try await list.add(text, note: note, barcode: code)
            BarcodeNames.remember(text, for: code)
            added.append(isNew ? text : "\(text) (already on the list)")
            reset()
        } catch {
            problem = Backend.friendlyMessage(for: error)
        }
    }

    private func reset() {
        name = ""
        note = ""
        problem = nil
        stage = .scanning
    }

    /// Finds a barcode in a photo the shopper picked (Apple's on-device barcode reader).
    private func readPhoto(_ item: PhotosPickerItem) async {
        problem = nil
        guard let data = try? await item.loadTransferable(type: Data.self),
              let image = UIImage(data: data), let cg = image.cgImage else {
            problem = "Couldn't open that photo."
            return
        }
        let code: String? = await Task.detached {
            let request = VNDetectBarcodesRequest()
            request.symbologies = [.ean13, .ean8, .upce, .code128]
            let orientation = CGImagePropertyOrientation(image.imageOrientation)
            try? VNImageRequestHandler(cgImage: cg, orientation: orientation).perform([request])
            return request.results?.compactMap(\.payloadStringValue).first { $0.allSatisfy(\.isNumber) }
        }.value
        if let code {
            await lookUp(code)
        } else {
            problem = "Couldn't find a barcode in that photo. Try one that's closer, flat and in focus."
        }
    }
}

/// The live camera scanner, reporting the first product barcode it sees.
private struct BarcodeCamera: UIViewControllerRepresentable {
    var onCode: (String) -> Void
    var onProblem: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerHost {
        let scanner = DataScannerViewController(
            // UPC-A barcodes (most US products) are read as EAN-13 with a leading 0.
            recognizedDataTypes: [.barcode(symbologies: [.ean13, .ean8, .upce])],
            qualityLevel: .accurate,
            recognizesMultipleItems: false,
            isHighFrameRateTrackingEnabled: true,
            isGuidanceEnabled: true,
            isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        let host = ScannerHost(scanner: scanner)
        host.onProblem = onProblem
        return host
    }

    func updateUIViewController(_ host: ScannerHost, context: Context) {
        context.coordinator.onCode = onCode
        host.onProblem = onProblem
    }

    static func dismantleUIViewController(_ host: ScannerHost, coordinator: Coordinator) {
        host.scanner.stopScanning()
    }

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    /// Holds the scanner and starts it once it's on screen. Starting earlier (while the view is
    /// being made) can leave the camera showing but never reading anything.
    final class ScannerHost: UIViewController {
        let scanner: DataScannerViewController
        var onProblem: ((String) -> Void)?

        init(scanner: DataScannerViewController) {
            self.scanner = scanner
            super.init(nibName: nil, bundle: nil)
        }

        required init?(coder: NSCoder) { fatalError("not used") }

        override func viewDidLoad() {
            super.viewDidLoad()
            addChild(scanner)
            scanner.view.frame = view.bounds
            scanner.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(scanner.view)
            scanner.didMove(toParent: self)
        }

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            guard !scanner.isScanning else { return }
            do {
                try scanner.startScanning()
            } catch {
                onProblem?("The camera couldn't start scanning (\(error.localizedDescription)). Type the numbers under the barcode, or use a photo.")
            }
        }
    }

    @MainActor
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        var onCode: (String) -> Void
        private var sent = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        private func report(_ items: [RecognizedItem]) {
            guard !sent else { return }
            for item in items {
                if case .barcode(let barcode) = item, let code = barcode.payloadStringValue,
                   (8...14).contains(code.filter(\.isNumber).count) {
                    sent = true
                    UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                    onCode(code)
                    return
                }
            }
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(addedItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didUpdate updatedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            report(allItems)
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didTapOn item: RecognizedItem) {
            report([item])
        }

        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) {
            sent = false
        }
    }
}

/// Names the shopper gave barcodes, kept on this phone so a rescan is instant (and works for
/// products no database knows).
enum BarcodeNames {
    private static let key = "barcodeNames"
    private static let maxNames = 300

    static func name(for code: String) -> String? {
        (UserDefaults.standard.dictionary(forKey: key) as? [String: String])?[code]
    }

    static func remember(_ name: String, for code: String) {
        var names = UserDefaults.standard.dictionary(forKey: key) as? [String: String] ?? [:]
        names[code] = name
        if names.count > maxNames { names.removeValue(forKey: names.keys.first(where: { $0 != code }) ?? "") }
        UserDefaults.standard.set(names, forKey: key)
    }
}

extension CGImagePropertyOrientation {
    init(_ orientation: UIImage.Orientation) {
        switch orientation {
        case .up: self = .up
        case .down: self = .down
        case .left: self = .left
        case .right: self = .right
        case .upMirrored: self = .upMirrored
        case .downMirrored: self = .downMirrored
        case .leftMirrored: self = .leftMirrored
        case .rightMirrored: self = .rightMirrored
        @unknown default: self = .up
        }
    }
}
