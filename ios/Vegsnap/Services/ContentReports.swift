import Foundation

struct ContentReport: Encodable {
    var kind: String
    var contentId = ""
    var text = ""
    var reason: String
    static func validID(_ id: String) -> Bool { id.range(of: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", options: .regularExpression) != nil }
    func validatedData() throws -> Data {
        let reason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !reason.isEmpty, self.reason.utf16.count <= 2000, self.text.utf16.count <= 8000,
              kind == "ai" && contentId.isEmpty && !text.isEmpty || kind == "community" && Self.validID(contentId) && text.isEmpty else { throw AppError(L("Check the report text and reason.")) }
        return try ContentReport(kind: kind, contentId: contentId, text: text, reason: reason).jsonData()
    }
    func submit() async throws -> String {
        let config = try ServiceConfiguration.load("community-service")
        var parts = URLComponents(string: config.baseUrl)!
        parts.path = "/api/reports"; parts.query = nil; parts.fragment = nil
        var request = URLRequest(url: parts.url!); request.httpMethod = "POST"; request.httpBody = try validatedData()
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        let (data, response) = try await Network.read(request, limit: 4096)
        struct Receipt: Decodable { var id: String }
        guard response.statusCode == 201, let receipt = try? JSONDecoder().decode(Receipt.self, from: data), Self.validID(receipt.id) else { throw AppError(L("Could not send the report. Please try again later.")) }
        try Task.checkCancellation()
        return receipt.id
    }
}
