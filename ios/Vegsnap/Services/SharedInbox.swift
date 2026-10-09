import Foundation

extension AppStore {
    func consumeInbox(fileManager: FileManager = .default) {
        // Never disturb a draft the user is still reviewing.
        guard !draft.hasContent, draftPhotos.isEmpty, let directory = inboxDirectory,
              let entries = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for entry in entries where UUID(uuidString: entry.lastPathComponent) != nil {
            var importedPhotos: [String] = []
            do {
                let data = try readLimitedFile(entry.appendingPathComponent("input.json"), limit: InboxPayload.byteLimit)
                let input = try JSONDecoder().decode(InboxPayload.self, from: data)
                guard input.text.utf16.count <= InboxPayload.textLimit, input.photos.count <= 3,
                      input.photos.allSatisfy({ $0 == URL(fileURLWithPath: $0).lastPathComponent && !$0.contains("..") }) else { throw AppError(L("Invalid shared content.")) }
                for photo in input.photos {
                    let data = try readLimitedFile(entry.appendingPathComponent(photo), limit: 30_000_000)
                    let clean = try PhotoProcessor.sanitize(data)
                    let name = UUID().uuidString + ".jpg"
                    importedPhotos.append(name)
                    try files.saveData(clean, name)
                }
                let nextDraft = CheckInput(text: input.text, category: settings.defaultCategory, locale: locale)
                let nextID = UUID().uuidString
                try files.save(Draft(id: nextID, input: nextDraft, photos: importedPhotos), "draft.json")
                draftID = nextID; draft = nextDraft; draftPhotos = importedPhotos; selectedTab = "check"
                do { try fileManager.removeItem(at: entry) }
                catch {
                    report(error)
                    // A retained, consumed share must never become a new draft again.
                    do { try fileManager.moveItem(at: entry, to: entry.appendingPathExtension("consumed")) }
                    catch { report(error) }
                }
                return
            } catch {
                for photo in importedPhotos { try? files.remove(photo) }
                report(error)
                // Retain the failed input for recovery, but exclude it from future imports.
                do { try fileManager.moveItem(at: entry, to: entry.appendingPathExtension("failed")) }
                catch { report(error) }
            }
        }
    }
}
