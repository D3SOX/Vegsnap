import UIKit
import SwiftUI
import UniformTypeIdentifiers

/// Share extension writes a bounded inbox item. Opening the app never automatically submits it.
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        let host = UIHostingController(rootView: ShareView(save: { [weak self] in try await self?.save() }, close: { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }))
        addChild(host); view.addSubview(host.view); host.view.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor), host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor), host.view.topAnchor.constraint(equalTo: view.topAnchor), host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)])
        host.didMove(toParent: self)
    }
    @MainActor private func save() async throws {
        guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.vegsnap.ios") else { throw NSError(domain: "Vegsnap", code: 1, userInfo: [NSLocalizedDescriptionKey: NSLocalizedString("The shared container is unavailable.", comment: "")]) }
        let id = UUID().uuidString
        let staging = directory.appendingPathComponent(id + ".pending", isDirectory: true)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        var resources = URLResourceValues(); resources.isExcludedFromBackup = true
        var resourceStaging = staging; try resourceStaging.setResourceValues(resources)
        defer { try? FileManager.default.removeItem(at: staging) }
        var text: [String] = []; var photos: [String] = []
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        for provider in items.flatMap({ $0.attachments ?? [] }).prefix(6) {
            if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), photos.count < 3 {
                let url: URL = try await withCheckedThrowingContinuation { continuation in
                    provider.loadFileRepresentation(forTypeIdentifier: UTType.image.identifier) { url, error in
                        do {
                            if let error { throw error }; guard let url else { throw CocoaError(.fileReadUnknown) }
                            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
                            guard (attributes[.size] as? Int ?? Int.max) <= 30_000_000 else { throw CocoaError(.fileReadTooLarge) }
                            let destination = staging.appendingPathComponent(UUID().uuidString + ".image")
                            try FileManager.default.copyItem(at: url, to: destination); continuation.resume(returning: destination)
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                photos.append(url.lastPathComponent)
            } else {
                let type = provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) ? UTType.url.identifier : UTType.plainText.identifier
                let value: String = try await withCheckedThrowingContinuation { continuation in
                    provider.loadItem(forTypeIdentifier: type) { item, error in
                        if let error { continuation.resume(throwing: error) }
                        else { continuation.resume(returning: (item as? URL)?.absoluteString ?? item as? String ?? "") }
                    }
                }
                text.append(String(value.prefix(30_000)))
            }
        }
        let data = try InboxPayload.encode(text: text.joined(separator: "\n"), photos: photos)
        try data.write(to: staging.appendingPathComponent("input.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.moveItem(at: staging, to: directory.appendingPathComponent(id, isDirectory: true))
    }
}
struct ShareView: View {
    var save: () async throws -> Void; var close: () -> Void
    @State private var busy = false; @State private var saved = false; @State private var error: String?
    var body: some View {
        NavigationStack { VStack(spacing: 24) {
            Image(systemName: saved ? "checkmark.circle" : "leaf.circle").font(.system(size: 60)).foregroundStyle(.green)
            Text(LocalizedStringKey(saved ? "Saved to Vegsnap" : "Check with Vegsnap")).font(.title2.bold())
            Text(LocalizedStringKey(saved ? "Open Vegsnap to review and check this product." : "The selected text and photos will be saved on this device. Review them in Vegsnap before checking.")).multilineTextAlignment(.center).foregroundStyle(.secondary)
            if let error { Text(error).foregroundStyle(.red) }
            if busy { ProgressView() }
            Button(LocalizedStringKey(saved ? "Done" : "Save product")) {
                if saved { close() } else { Task { busy = true; defer { busy = false }; do { try await save(); saved = true } catch { self.error = error.localizedDescription } } }
            }.buttonStyle(.borderedProminent).disabled(busy)
        }.padding(30).navigationTitle("Vegsnap").navigationBarTitleDisplayMode(.inline).toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: close) } } }
    }
}
