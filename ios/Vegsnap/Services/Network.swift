import Foundation

final class RedirectPolicy: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    let allowsHTTPS: Bool
    init(allowsHTTPS: Bool = false) { self.allowsHTTPS = allowsHTTPS }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        guard allowsHTTPS, let url = request.url, url.scheme == "https", url.user == nil, url.password == nil else { completionHandler(nil); return }
        var clean = request; clean.setValue(nil, forHTTPHeaderField: "Authorization"); clean.setValue(nil, forHTTPHeaderField: "Cookie")
        completionHandler(clean)
    }
}
enum Network {
    #if DEBUG
    static var testProtocolClasses: [AnyClass]?
    #endif
    static func session(redirects: Bool = false) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        #if DEBUG
        config.protocolClasses = testProtocolClasses
        #endif
        config.httpCookieStorage = nil; config.httpShouldSetCookies = false; config.urlCache = nil
        config.timeoutIntervalForRequest = 40; config.timeoutIntervalForResource = 140
        return URLSession(configuration: config, delegate: RedirectPolicy(allowsHTTPS: redirects), delegateQueue: nil)
    }
    static func read(_ request: URLRequest, limit: Int = 2_000_000, redirects: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let session = session(redirects: redirects)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, response.expectedContentLength <= Int64(limit) else { throw AppError(L("Response exceeds the size limit.")) }
        var data = Data()
        for try await byte in bytes {
            if data.count % 8192 == 0 { try Task.checkCancellation() }
            guard data.count < limit else { throw AppError(L("Response exceeds the size limit.")) }
            data.append(byte)
        }
        return (data, http)
    }
    static func get(_ url: URL, limit: Int = 2_000_000, redirects: Bool = false) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("Vegsnap/0.2 (iOS; explicit product lookup)", forHTTPHeaderField: "User-Agent")
        let (data, response) = try await read(request, limit: limit, redirects: redirects)
        guard (200..<300).contains(response.statusCode) else { throw AppError("\(L("Service returned HTTP")) \(response.statusCode)") }
        return data
    }
}
