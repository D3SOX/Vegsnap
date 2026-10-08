import Foundation

extension AppStore {
    func consumeInbox() {
        guard let directory = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: "group.app.vegsnap.ios"), let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for entry in entries where UUID(uuidString: entry.lastPathComponent) != nil {
            do {
                struct Inbox: Decodable { var text: String; var photos: [String] }
                let data = try Data(contentsOf: entry.appendingPathComponent("input.json"))
                guard data.count <= 100_000 else { throw AppError(L("Shared content is too large.")) }
                let input = try JSONDecoder().decode(Inbox.self, from: data)
                guard input.text.count <= 30_000, input.photos.count <= 3,
                      input.photos.allSatisfy({ $0 == URL(fileURLWithPath: $0).lastPathComponent && !$0.contains("..") }) else { throw AppError(L("Invalid shared content.")) }
                // Preserve an existing draft; shared input stays queued locally until the user starts it.
                if draft.hasContent || !draftPhotos.isEmpty { return }
                for photo in input.photos { try addPhoto(Data(contentsOf: entry.appendingPathComponent(photo))) }
                draft.text = input.text; saveDraft(); selectedTab = "check"
                try FileManager.default.removeItem(at: entry)
                return
            } catch { report(error); return }
        }
    }
}
