import Foundation

extension AppStore {
    func consumeInbox() {
        // Never disturb a draft the user is still reviewing.
        guard !draft.hasContent, draftPhotos.isEmpty, let directory = inboxDirectory,
              let entries = try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for entry in entries where UUID(uuidString: entry.lastPathComponent) != nil {
            var importedPhotos: [String] = []
            do {
                struct Inbox: Decodable { var text: String; var photos: [String] }
                let data = try readLimitedFile(entry.appendingPathComponent("input.json"), limit: 100_000)
                let input = try JSONDecoder().decode(Inbox.self, from: data)
                guard input.text.utf16.count <= 30_000, input.photos.count <= 3,
                      input.photos.allSatisfy({ $0 == URL(fileURLWithPath: $0).lastPathComponent && !$0.contains("..") }) else { throw AppError(L("Invalid shared content.")) }
                for photo in input.photos {
                    let data = try readLimitedFile(entry.appendingPathComponent(photo), limit: 30_000_000)
                    let clean = try PhotoProcessor.sanitize(data)
                    let name = UUID().uuidString + ".jpg"
                    importedPhotos.append(name)
                    try files.saveData(clean, name)
                }
                let nextDraft = CheckInput(text: input.text, category: settings.defaultCategory, locale: locale)
                try files.save(Draft(input: nextDraft, photos: importedPhotos), "draft.json")
                draft = nextDraft; draftPhotos = importedPhotos; selectedTab = "check"
                do { try FileManager.default.removeItem(at: entry) } catch { report(error) }
                return
            } catch {
                for photo in importedPhotos { try? files.remove(photo) }
                report(error)
                // Retain the failed input for recovery, but exclude it from future imports.
                do { try FileManager.default.moveItem(at: entry, to: entry.appendingPathExtension("failed")) }
                catch { report(error) }
            }
        }
    }
}
