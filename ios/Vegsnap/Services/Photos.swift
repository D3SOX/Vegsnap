import UIKit
import Vision
import ImageIO
import CoreTransferable
import UniformTypeIdentifiers

/// Decode a bounded thumbnail rather than allocating full-resolution images. Redrawing strips EXIF/GPS.
enum PhotoProcessor {
    static func sanitize(_ data: Data) throws -> Data {
        guard data.count <= 30_000_000, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: 1800, kCGImageSourceCreateThumbnailWithTransform: true] as CFDictionary) else { throw AppError(L("This photo could not be opened.")) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: image.width, height: image.height), format: format)
        let clean = renderer.image { context in
            UIColor.white.setFill(); context.fill(CGRect(x: 0, y: 0, width: image.width, height: image.height))
            UIImage(cgImage: image).draw(in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return try boundedJPEG(clean)
    }
    private static func boundedJPEG(_ image: UIImage) throws -> Data {
        // Leave room for the data URL prefix within the provider's 4,000,000-character cap.
        for quality in [0.82, 0.7, 0.55, 0.4] {
            if let output = image.jpegData(compressionQuality: quality), output.count <= 2_999_970 { return output }
        }
        throw AppError(L("Choose a smaller photo."))
    }
    static func recognize(_ data: Data, languages: [String]) async throws -> (text: String, barcode: String?) {
        let requests = OCRRequests()
        let worker = Task.detached(priority: .userInitiated) {
            try Task.checkCancellation()
            // Reject corrupt stored photos before Vision initializes recognition models.
            guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                  let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw AppError(L("This photo could not be opened.")) }
            let text = requests.text; text.recognitionLevel = .accurate; text.usesLanguageCorrection = true
            let available = try text.supportedRecognitionLanguages()
            text.recognitionLanguages = languages.filter { available.contains($0) }
            text.automaticallyDetectsLanguage = true
            let barcode = requests.barcode; barcode.symbologies = [.ean8, .ean13, .upce, .itf14]
            try Task.checkCancellation()
            do { try VNImageRequestHandler(cgImage: image).perform([text, barcode]) }
            catch { try Task.checkCancellation(); throw error }
            try Task.checkCancellation()
            return (text.results?.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n") ?? "", barcode.results?.first.flatMap { observation in observation.payloadStringValue.map { observation.symbology == .upce ? expandUPCE($0) : $0 } })
        }
        return try await withTaskCancellationHandler {
            let result = try await worker.value
            try Task.checkCancellation()
            return result
        } onCancel: {
            worker.cancel()
            requests.text.cancel(); requests.barcode.cancel()
        }
    }
    static func rotate(_ data: Data) throws -> Data {
        guard let image = UIImage(data: data) else { throw AppError(L("This photo could not be opened.")) }
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let rotated = UIGraphicsImageRenderer(size: CGSize(width: image.size.height, height: image.size.width), format: format).image { context in
            context.cgContext.translateBy(x: image.size.height, y: 0); context.cgContext.rotate(by: .pi / 2)
            image.draw(at: .zero)
        }
        return try boundedJPEG(rotated)
    }
}

/// Vision returns compressed UPC-E. Expand before the common GTIN checksum validator.
func expandUPCE(_ value: String) -> String {
    let d = Array(value)
    guard d.count == 8, d.allSatisfy({ $0.isASCII && $0.isNumber }), d[0] == "0" || d[0] == "1" else { return value }
    let body: String
    switch d[6] {
    case "0", "1", "2": body = String(d[1...2]) + String(d[6]) + "0000" + String(d[3...5])
    case "3": body = String(d[1...3]) + "00000" + String(d[4...5])
    case "4": body = String(d[1...4]) + "00000" + String(d[5])
    default: body = String(d[1...5]) + "0000" + String(d[6])
    }
    return String(d[0]) + body + String(d[7])
}

/// PhotosPicker lends a file URL; read only the supported byte budget while it is valid.
struct PickedPhoto: Transferable {
    let data: Data
    static func load(_ url: URL) throws -> PickedPhoto {
        PickedPhoto(data: try readLimitedFile(url, limit: 30_000_000))
    }
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in try load(received.file) }
    }
}

// The worker configures/reads the requests; the cancellation handler only calls Vision's cancel().
private final class OCRRequests: @unchecked Sendable {
    let text = VNRecognizeTextRequest()
    let barcode = VNDetectBarcodesRequest()
}
