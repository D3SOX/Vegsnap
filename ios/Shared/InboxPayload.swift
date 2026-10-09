import Foundation

struct InboxPayload: Codable {
    static let byteLimit = 100_000
    static let textLimit = 30_000
    var text: String
    var photos: [String]

    static func encode(text: String, photos: [String]) throws -> Data {
        // Binary search a Unicode-safe prefix against both consumer limits,
        // including JSON escaping and photo names in the encoded byte count.
        let characters = Array(text.prefix(textLimit))
        var low = 0; var high = characters.count
        var result = try JSONEncoder().encode(InboxPayload(text: "", photos: photos))
        while low <= high {
            let count = (low + high) / 2
            let prefix = String(characters.prefix(count))
            let data = try JSONEncoder().encode(InboxPayload(text: prefix, photos: photos))
            if prefix.utf16.count <= textLimit && data.count <= byteLimit {
                result = data; low = count + 1
            } else { high = count - 1 }
        }
        return result
    }
}
