import Darwin
import Foundation

@main
enum ListeningURLTests {
    static func fail(_ message: String) -> Never {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }

    static func expect(_ condition: Bool, _ message: String) {
        if !condition { fail(message) }
    }

    static func expectEqual<T: Equatable>(_ got: T, _ want: T, _ message: String) {
        if got != want { fail("\(message): got \(got), want \(want)") }
    }

    static func main() {
        expect(parseListeningURL(from: "not a bind line") == nil, "ignore unrelated logs")
        expect(parseListeningURL(from: "Server listening on http://example.com:8080") == nil, "reject non-loopback")
        expect(parseListeningURL(from: "Server listening on https://127.0.0.1:8080") == nil, "reject https")
        expect(parseListeningURL(from: "Server listening on http://0.0.0.0:8080") == nil, "reject wildcard bind")

        guard let loopback = parseListeningURL(from: "Server listening on http://127.0.0.1:8091 extra") else {
            fail("parse 127.0.0.1")
        }
        expectEqual(loopback.host, "127.0.0.1", "host")
        expectEqual(loopback.port, 8091, "port")
        expect(isLoopbackHost(loopback.host), "loopback host")

        guard let server = URL(string: "http://127.0.0.1:8091") else { fail("server url") }
        expect(isServerOrigin(URL(string: "http://127.0.0.1:8091/import")!, serverURL: server), "same origin path")
        expect(!isServerOrigin(URL(string: "http://127.0.0.1:8092/")!, serverURL: server), "other port")
        expect(!isServerOrigin(URL(string: "http://localhost:8091/")!, serverURL: server), "localhost is a different origin")
        expect(isServerBlob(URL(string: "blob:http://127.0.0.1:8091/abc")!, serverURL: server), "blob prefix")
        expect(!isServerBlob(URL(string: "blob:http://127.0.0.1:9/abc")!, serverURL: server), "blob other port")

        expectEqual(sanitizedDownloadName("../../etc/passwd"), "passwd", "path traversal")
        expectEqual(sanitizedDownloadName("  "), "download", "blank name")
        expectEqual(sanitizedDownloadName("export.jsonl"), "export.jsonl", "plain name")

        expect(isAllowedAboutURL(URL(string: "about:blank")!), "about:blank")
        expect(!isAllowedAboutURL(URL(string: "about:srcdoc")!), "about:srcdoc")

        let cancelled = NSError(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
        expect(isNavigationCancelError(cancelled), "cancelled load")
        let timedOut = NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        expect(!isNavigationCancelError(timedOut), "timeout is real")

        let start = DispatchTime.now()
        var parsed = 0
        for _ in 0..<20_000 {
            if parseListeningURL(from: "Server listening on http://127.0.0.1:8080\n") != nil {
                parsed += 1
            }
        }
        let elapsedNs = DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds
        expectEqual(parsed, 20_000, "parse throughput")
        if elapsedNs > 250_000_000 {
            fail("parseListeningURL too slow: \(elapsedNs) ns for 20k parses")
        }

        print("ListeningURL tests passed (\(elapsedNs / 1_000) µs / 20k parses)")
    }
}
