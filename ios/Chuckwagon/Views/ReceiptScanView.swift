import PhotosUI
import SwiftUI
import UIKit

/// "Scan a receipt": a photo of a receipt teaches Chuckwagon a store's everyday prices,
/// so meal plans can price the items that aren't on sale.
struct ReceiptScanView: View {
    let store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var pickerItem: PhotosPickerItem?
    @State private var showingCamera = false
    @State private var scanning = false
    @State private var result: Backend.ReceiptScan?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Snap your \(store.chain) receipt and we'll learn its everyday prices. Your plans get more accurate totals, and so does everyone shopping \(store.chain).")
                        .font(Theme.body(.subheadline))
                        .foregroundStyle(Theme.ink.opacity(0.8))
                    if UIImagePickerController.isSourceTypeAvailable(.camera) {
                        Button { showingCamera = true } label: { Label("Take a photo", systemImage: "camera.fill") }
                            .disabled(scanning)
                    }
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        Label("Choose from Photos", systemImage: "photo.on.rectangle")
                    }
                    .disabled(scanning)
                } footer: {
                    Text("Lay the receipt flat in good light. We keep the prices, not the photo.")
                }

                if scanning {
                    Section { HStack { ProgressView(); Text("Reading your receipt…").padding(.leading, 8) } }
                }
                if let error {
                    Section { Text(error).foregroundStyle(Color.chuckRed) }
                }
                if let result {
                    Section("Learned \(result.items.count) prices") {
                        ForEach(result.items, id: \.self) { item in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(item.name)
                                    if let size = item.size { Text(size).font(.caption).foregroundStyle(.secondary) }
                                }
                                Spacer()
                                Text(item.price.dollars + (item.soldBy == "WEIGHT" ? "/lb" : "")).bold()
                            }
                        }
                    }
                }
            }
            .navigationTitle("Scan a receipt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { Button("Done") { dismiss() } }
            .creamBackground()
            .sheet(isPresented: $showingCamera) {
                CameraPicker { image in Task { await scan(image) } }.ignoresSafeArea()
            }
            .onChange(of: pickerItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data) {
                        await scan(image)
                    } else {
                        error = "Couldn't open that photo."
                    }
                    pickerItem = nil
                }
            }
        }
    }

    private func scan(_ image: UIImage) async {
        guard let storeId = store.id else { return }
        scanning = true
        error = nil
        result = nil
        defer { scanning = false }
        do {
            result = try await Backend.scanReceipt(storeId: storeId, image: image)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// The system camera, for one photo.
struct CameraPicker: UIViewControllerRepresentable {
    var onPhoto: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onPhoto(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
    }
}
