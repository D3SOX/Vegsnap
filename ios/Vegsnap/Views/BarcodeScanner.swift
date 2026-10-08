import SwiftUI
import VisionKit
import AVFoundation

struct BarcodeScanner: View {
    @Environment(\.dismiss) private var dismiss
    var onCode: (String) -> Void
    @State private var authorized = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
    @State private var failure: String?
    var body: some View {
        NavigationStack {
            Group {
                if let failure { ContentUnavailableView(L("Scanner unavailable"), systemImage: "barcode", description: Text(failure)) }
                else if authorized && DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                    ScannerController { code in onCode(code); dismiss() } onError: { failure = $0 }
                        .overlay(alignment: .bottom) { Text(L("Point the camera at a product barcode.")).padding().background(.regularMaterial, in: Capsule()).padding() }
                } else { ContentUnavailableView(L("Scanner unavailable"), systemImage: "barcode", description: Text(L("Allow camera access in iOS Settings, or enter the barcode manually."))) }
            }.navigationTitle(L("Scan barcode")).navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } } }
        }.task {
            if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined { authorized = await AVCaptureDevice.requestAccess(for: .video) }
        }
    }
}
struct ScannerController: UIViewControllerRepresentable {
    var onCode: (String) -> Void; var onError: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let view = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.ean8, .ean13, .upce, .itf14])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isHighlightingEnabled: true)
        view.delegate = context.coordinator
        do { try view.startScanning() } catch { DispatchQueue.main.async { onError(error.localizedDescription) } }
        return view
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ controller: DataScannerViewController, coordinator: Coordinator) { controller.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let parent: ScannerController; var found = false
        init(_ parent: ScannerController) { self.parent = parent }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !found else { return }
            for item in addedItems { if case let .barcode(barcode) = item, let value = barcode.payloadStringValue { found = true; dataScanner.stopScanning(); parent.onCode(barcode.observation.symbology == .upce ? expandUPCE(value) : value); return } }
        }
        func dataScanner(_ dataScanner: DataScannerViewController, becameUnavailableWithError error: DataScannerViewController.ScanningUnavailable) { parent.onError(error.localizedDescription) }
    }
}
