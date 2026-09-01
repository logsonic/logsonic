import Foundation

func isLoopbackHost(_ host: String?) -> Bool {
    switch host?.lowercased() {
    case "localhost", "127.0.0.1", "::1": return true
    default: return false
    }
}

func parseListeningURL(from line: String) -> URL? {
    let marker = "Server listening on "
    guard let markerRange = line.range(of: marker) else { return nil }
    let candidate = line[markerRange.upperBound...].split(whereSeparator: { $0.isWhitespace }).first.map(String.init) ?? ""
    guard let parsedURL = URL(string: candidate), parsedURL.scheme == "http", isLoopbackHost(parsedURL.host) else {
        return nil
    }
    return parsedURL
}

func effectivePort(_ url: URL) -> Int? {
    if let port = url.port { return port }
    switch url.scheme?.lowercased() {
    case "http": return 80
    case "https": return 443
    default: return nil
    }
}

func isServerOrigin(_ url: URL, serverURL: URL) -> Bool {
    url.scheme?.lowercased() == serverURL.scheme?.lowercased()
        && url.host?.lowercased() == serverURL.host?.lowercased()
        && effectivePort(url) == effectivePort(serverURL)
}

func isServerBlob(_ url: URL, serverURL: URL) -> Bool {
    guard url.scheme?.lowercased() == "blob" else { return false }
    return url.absoluteString.hasPrefix("blob:\(serverURL.absoluteString)/")
}

func sanitizedDownloadName(_ suggested: String) -> String {
    let name = (suggested as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
    if name.isEmpty || name == "." || name == ".." { return "download" }
    return name
}

func isNavigationCancelError(_ error: Error) -> Bool {
    let nsError = error as NSError
    return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
}

func isAllowedAboutURL(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "about" && url.absoluteString.lowercased() == "about:blank"
}

func lockFileURL(bundleIdentifier: String) -> URL {
    let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
    let dir = support.appendingPathComponent("Logsonic", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let safe = bundleIdentifier.replacingOccurrences(of: "/", with: "-")
    return dir.appendingPathComponent("app-\(safe).lock")
}
