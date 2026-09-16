// Pure decision logic for macos-b1's window-drag region. WKWebView swallows
// mouse events, so the actual hit-test (is the mousedown target interactive?)
// happens in injected JS (see dragStripHookJS in LogsonicApp.swift) -- this
// function only decides what to DO once that JS has posted a message with
// the coordinates and interactivity flag. The two sides can't share code
// (one is JS, one is Swift); keep them in sync by hand if the rule changes.
import CoreGraphics

enum DragStripAction: Equatable {
    case none
    case drag
    case zoom
}

func dragStripAction(
    y: CGFloat,
    stripHeight: CGFloat,
    targetIsInteractive: Bool,
    clickCount: Int
) -> DragStripAction {
    guard y >= 0, y < stripHeight, !targetIsInteractive else { return .none }
    return clickCount >= 2 ? .zoom : .drag
}
