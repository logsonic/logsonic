import Darwin
import Foundation

@main
enum DragStripTests {
    static func fail(_ message: String) -> Never {
        fputs("FAIL: \(message)\n", stderr)
        exit(1)
    }

    static func expectEqual<T: Equatable>(_ got: T, _ want: T, _ message: String) {
        if got != want { fail("\(message): got \(got), want \(want)") }
    }

    static func main() {
        expectEqual(
            dragStripAction(y: 60, stripHeight: 44, targetIsInteractive: false, clickCount: 1),
            .none,
            "below the strip"
        )
        expectEqual(
            dragStripAction(y: 10, stripHeight: 44, targetIsInteractive: true, clickCount: 1),
            .none,
            "in strip but interactive"
        )
        expectEqual(
            dragStripAction(y: 10, stripHeight: 44, targetIsInteractive: false, clickCount: 1),
            .drag,
            "in strip, not interactive, single click"
        )
        expectEqual(
            dragStripAction(y: 10, stripHeight: 44, targetIsInteractive: false, clickCount: 2),
            .zoom,
            "in strip, not interactive, double click"
        )

        print("DragStrip tests passed")
    }
}
