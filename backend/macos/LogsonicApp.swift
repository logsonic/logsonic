// LogsonicApp — the native macOS GUI shell for Logsonic.app.
//
// Why this exists: the Logsonic server is a plain Go HTTP binary with no Cocoa
// event loop. Launched directly from a .app bundle it has no Dock presence and
// macOS flags it "not responding" (Force Quit only — a SIGKILL with no graceful
// shutdown). This AppKit shell is the bundle's CFBundleExecutable instead: it
// shows the responsive LogSonic Dock icon, hosts the embedded web UI in a
// WKWebView, runs the Go server (Contents/MacOS/logsonic) as a child, and on
// Quit / window-close sends the child SIGINT so it drains the HTTP server and
// closes its indices cleanly.
//
// The SPA is served by the Go process (go:embed). By default the webview loads
// http://127.0.0.1:<port> so API calls stay same-origin. Pass --browser (or
// LOGSONIC_BROWSER=1) to open the system browser instead and keep only the
// server-log window. View → Open in Browser always works. External links leave
// the app. The CLI (`logsonic -open`) never uses this shell.
//
// macos-b1 "visible nativeness" (unified titlebar, native-detection contract,
// appearance-follow, window memory) — see DragStrip.swift for the window-drag
// decision function and its own header comment for the JS/Swift split:
//   - Titlebar: transparent + .fullSizeContentView, traffic lights inset over
//     the web header. Drag-by-header works via an injected mousedown hook
//     (dragStripHookJS) that posts to the "logsonicDrag" message handler,
//     since WKWebView swallows native mouse events.
//   - `window.__LOGSONIC_NATIVE__` is injected at document start
//     (nativeContractJS) so the frontend can detect the shell.
//   - Appearance: NSApp.effectiveAppearance is observed via KVO; changes are
//     pushed into the page (`window.__logsonicSetSystemAppearance`) and drive
//     the window/webview background directly (no white flash before the SPA
//     paints). The page posts back via "logsonicTheme" whenever its own
//     resolved theme changes (explicit user choice), so the window stays in
//     sync even when not following the system.
//   - Both windows persist their frame via NSWindow.setFrameAutosaveName
//     ("main" / "serverLog").
//
// Build (universal) — see scripts/app-macos.sh:
//   swiftc -O -target arm64-apple-macos11  -framework AppKit -framework WebKit \
//     ListeningURL.swift DragStrip.swift LogsonicApp.swift -o app-arm64
//   swiftc -O -target x86_64-apple-macos11 -framework AppKit -framework WebKit \
//     ListeningURL.swift DragStrip.swift LogsonicApp.swift -o app-x86_64
//   lipo -create app-arm64 app-x86_64 -o LogsonicApp

import AppKit
import Darwin
import Foundation
import WebKit

// LogSonic brand purple (#6d5dfc), matching the app icon.
let brandColor = NSColor(srgbRed: 0x6D / 255.0, green: 0x5D / 255.0, blue: 0xFC / 255.0, alpha: 1)
let consoleBG = NSColor(srgbRed: 0x17 / 255.0, green: 0x17 / 255.0, blue: 0x1F / 255.0, alpha: 1)
let consoleFG = NSColor(srgbRed: 0xCF / 255.0, green: 0xD2 / 255.0, blue: 0xDC / 255.0, alpha: 1)
// macos-b1 no-white-flash colors, matching frontend/src/index.css's
// `--background` token as actually rendered: the unlayered
// `[data-theme="dark"] { --background: 240 6% 6% }` bridge rule wins the
// cascade over @layer base's `.dark { --background: 222.2 84% 4.9% }`
// (unlayered always beats layered at equal specificity). Kept in sync by
// hand -- there is no build-time bridge between the two files.
let appBackgroundLight = NSColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)
let appBackgroundDark = NSColor(srgbRed: 0x0E / 255.0, green: 0x0E / 255.0, blue: 0x10 / 255.0, alpha: 1)
private let maxConsoleCharacters = 1_000_000
private let trimmedConsoleCharacters = 750_000
private let maxBufferedLogLineCharacters = 64 * 1024
private let maxServerRestarts = 3

private let blobDownloadHookJS = """
(function() {
  if (window.__logsonicDownloadHook) return;
  window.__logsonicDownloadHook = true;
  function intercept(anchor) {
    if (!anchor || !anchor.download || !anchor.href || anchor.href.indexOf('blob:') !== 0) return false;
    var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.logsonicDownload;
    if (!handler) return false;
    fetch(anchor.href).then(function(r) { return r.blob(); }).then(function(blob) {
      var reader = new FileReader();
      reader.onloadend = function() {
        var result = typeof reader.result === 'string' ? reader.result : '';
        var comma = result.indexOf(',');
        handler.postMessage({ filename: anchor.download || 'download', data: comma >= 0 ? result.slice(comma + 1) : '' });
      };
      reader.readAsDataURL(blob);
    });
    return true;
  }
  document.addEventListener('click', function(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[download]') : null;
    if (intercept(a)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  var proto = HTMLAnchorElement.prototype;
  var origClick = proto.click;
  proto.click = function() {
    if (intercept(this)) return;
    return origClick.call(this);
  };
})();
"""

// The window-drag strip height, in CSS px. Matches frontend/src/index.css's
// --ls-topbar-h (44px), not the spec's original 52px placeholder -- kept in
// sync by hand, same caveat as the background colors above.
let dragStripHeight: CGFloat = 44

// WKWebView swallows native mouse events, so a CSS-only drag region isn't
// possible. This hooks document-level mousedown: if it's within the top
// strip and not on an interactive element (or an element/ancestor marked
// data-native-drag="false"), it posts to the "logsonicDrag" handler with the
// DOM's own click count so Swift can tell a drag from a double-click zoom.
// The strip-height/interactivity check happens here in JS (Swift has no
// visibility into the DOM); dragStripAction() in DragStrip.swift still makes
// the final drag-vs-zoom call so there is one tested decision function, not
// two copies of the "clickCount >= 2" rule.
private let dragStripHookJS = """
(function() {
  if (window.__logsonicDragHook) return;
  window.__logsonicDragHook = true;
  var STRIP_HEIGHT = \(Int(dragStripHeight));
  var INTERACTIVE_TAGS = { BUTTON: 1, INPUT: 1, A: 1, SELECT: 1, TEXTAREA: 1 };
  document.addEventListener('mousedown', function(e) {
    if (e.button !== 0 || e.clientY < 0 || e.clientY >= STRIP_HEIGHT) return;
    var el = e.target;
    while (el && el !== document.body) {
      if (INTERACTIVE_TAGS[el.tagName] || (el.getAttribute && el.getAttribute('data-native-drag') === 'false')) return;
      el = el.parentElement;
    }
    var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.logsonicDrag;
    if (handler) handler.postMessage({ clickCount: e.detail || 1 });
  }, true);
})();
"""

// Injected once at document start so the frontend can detect the shell
// before any application code runs (macos-b1's native-detection contract).
private func nativeContractJS(shellVersion: String) -> String {
    """
    window.__LOGSONIC_NATIVE__ = { platform: 'macos', shellVersion: \(String(reflecting: shellVersion)), token: undefined };
    """
}

final class NativeFileSchemeHandler: NSObject, WKURLSchemeHandler {
    private var files: [String: URL] = [:]
    private let lock = NSLock()

    func register(_ file: URL) -> String {
        let id = UUID().uuidString
        lock.lock(); files[id] = file; lock.unlock()
        return id
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let id = urlSchemeTask.request.url?.host else {
            urlSchemeTask.didFailWithError(NSError(domain: "logsonic", code: 1))
            return
        }
        lock.lock(); let file = files[id]; lock.unlock()
        guard let file else {
            urlSchemeTask.didFailWithError(NSError(domain: "logsonic", code: 2))
            return
        }
        do {
            let attrs = try FileManager.default.attributesOfItem(atPath: file.path)
            // now-08: the primary Dock-drop/Open-With path no longer uses this
            // handler at all (see openNativeFiles) -- paths go straight to the
            // server instead. This handler is kept only as a --browser-mode
            // fallback and still does a full Data(contentsOf:) read below, so
            // the cap stays; inlined since deleting the named constant was the
            // spec's ask, not deleting the guard it protects.
            if let size = attrs[.size] as? NSNumber, size.intValue > 512 * 1024 * 1024 {
                urlSchemeTask.didFailWithError(NSError(domain: "logsonic", code: 3, userInfo: [
                    NSLocalizedDescriptionKey: "File too large to open via Dock",
                ]))
                return
            }
            let data = try Data(contentsOf: file, options: .mappedIfSafe)
            guard let reqURL = urlSchemeTask.request.url else { return }
            let resp = HTTPURLResponse(url: reqURL, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
                "Content-Type": "application/octet-stream",
                "Access-Control-Allow-Origin": "*",
                "Content-Length": "\(data.count)",
            ])!
            urlSchemeTask.didReceive(resp)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } catch {
            urlSchemeTask.didFailWithError(error)
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

// MARK: - Status pill (colored dot + label in a rounded chip)

final class StatusPill: NSView {
    private let dot = NSView()
    private let label = NSTextField(labelWithString: "")

    init() {
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 11
        layer?.backgroundColor = NSColor.labelColor.withAlphaComponent(0.06).cgColor
        layer?.borderWidth = 1
        layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.6).cgColor
        translatesAutoresizingMaskIntoConstraints = false

        dot.wantsLayer = true
        dot.layer?.cornerRadius = 4
        dot.translatesAutoresizingMaskIntoConstraints = false

        label.font = .systemFont(ofSize: 12, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.translatesAutoresizingMaskIntoConstraints = false

        addSubview(dot)
        addSubview(label)
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 22),
            dot.widthAnchor.constraint(equalToConstant: 8),
            dot.heightAnchor.constraint(equalToConstant: 8),
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 11),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            label.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 7),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            trailingAnchor.constraint(equalTo: label.trailingAnchor, constant: 12),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not implemented") }

    func set(_ text: String, color: NSColor) {
        label.stringValue = text
        dot.layer?.backgroundColor = color.cgColor
        dot.layer?.shadowColor = color.cgColor
        dot.layer?.shadowOpacity = 0.9
        dot.layer?.shadowRadius = 3
        dot.layer?.shadowOffset = .zero
    }
}

// MARK: - App delegate

private func envTrue(_ key: String) -> Bool {
    switch (ProcessInfo.processInfo.environment[key] ?? "").lowercased() {
    case "1", "true", "yes", "on": return true
    default: return false
    }
}

private func wantsBrowserUI() -> Bool {
    if envTrue("LOGSONIC_BROWSER") { return true }
    return CommandLine.arguments.contains { $0 == "--browser" || $0 == "-browser" }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView?
    private var useBrowser = false
    private let overlay = NSTextField(labelWithString: "Starting server…")
    private let console = NSTextView()
    private let status = StatusPill()
    private var copyLogsButton: NSButton!
    private var logWindow: NSWindow?
    private var showLogMenuItem: NSMenuItem!
    private let nativeFiles = NativeFileSchemeHandler()
    private var lockFD: Int32 = -1
    private var loadAttempts = 0
    private var restartCount = 0

    private var storageDir: String?

    private var process: Process?
    private var serverURL: String?
    private var parsedServerURL: URL?
    private var pendingNativeFilePayloads: [(paths: [String], mtimes: [String?])] = []
    private var lineBuffer = ""
    private var quitting = false

    // macos-b1: the last real left-mouse-down the UI process saw, captured
    // via a local event monitor. WKWebView's IPC hop means NSApp.currentEvent
    // at the moment a "logsonicDrag" message arrives is not reliably the
    // originating mousedown -- performDrag(with:) needs a genuine one.
    private var lastMouseDown: NSEvent?
    private var appearanceObservation: NSKeyValueObservation?

    func applicationDidFinishLaunching(_ notification: Notification) {
        useBrowser = wantsBrowserUI()
        if !acquireInstanceLock() {
            activateExistingInstance()
            NSApp.terminate(nil)
            return
        }
        NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            self?.lastMouseDown = event
            return event
        }
        buildMenu()
        buildWindow()
        observeAppearance()
        status.set("Starting…", color: .systemOrange)
        startServer()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func application(_ sender: NSApplication, openFile filename: String) -> Bool {
        openNativeFiles([filename])
        return true
    }

    func application(_ sender: NSApplication, openFiles filenames: [String]) {
        openNativeFiles(filenames)
        sender.reply(toOpenOrPrint: .success)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if sender === window {
            NSApp.terminate(nil)
            return false
        }
        return true
    }

    func windowWillClose(_ notification: Notification) {
        if notification.object as? NSWindow === logWindow {
            logWindow = nil
            showLogMenuItem?.state = .off
        }
    }

    // MARK: UI construction

    private func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Hide LogSonic", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit LogSonic", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let fileItem = NSMenuItem()
        mainMenu.addItem(fileItem)
        let fileMenu = NSMenu(title: "File")
        fileMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose), keyEquivalent: "w")
        fileItem.submenu = fileMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: #selector(UndoManager.undo), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: #selector(UndoManager.redo), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Copy All Logs", action: #selector(copyLogs), keyEquivalent: "C")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reloadUI), keyEquivalent: "r")
        viewMenu.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "")
        viewMenu.addItem(withTitle: "Copy Server URL", action: #selector(copyURL), keyEquivalent: "")
        viewMenu.addItem(NSMenuItem.separator())
        let logItem = viewMenu.addItem(withTitle: "Server Log", action: #selector(toggleLogWindow), keyEquivalent: "l")
        logItem.state = .off
        logItem.isEnabled = !useBrowser
        showLogMenuItem = logItem
        viewMenu.addItem(withTitle: "Reveal Index in Finder", action: #selector(revealInFinder), keyEquivalent: "")
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }

    private func buildWindow() {
        if useBrowser {
            window = makeLogWindow(title: "LogSonic")
            logWindow = window
            showLogMenuItem?.state = .on
            window.center()
            window.setFrameAutosaveName("main")
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "LogSonic"
        window.minSize = NSSize(width: 900, height: 600)
        window.center()
        window.isReleasedWhenClosed = false
        window.delegate = self

        // Unified titlebar: traffic lights float over the web header instead
        // of a separate title bar strip. The web header pads itself left so
        // its own content clears the buttons (frontend .is-native-macos CSS).
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        window.setFrameAutosaveName("main")

        let dark = isDarkAppearance(NSApp.effectiveAppearance)
        window.backgroundColor = dark ? appBackgroundDark : appBackgroundLight

        let config = WKWebViewConfiguration()
        let controller = config.userContentController
        controller.add(self, name: "logsonicDownload")
        controller.add(self, name: "logsonicDrag")
        controller.add(self, name: "logsonicTheme")
        controller.addUserScript(WKUserScript(source: blobDownloadHookJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(WKUserScript(source: dragStripHookJS, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
        controller.addUserScript(WKUserScript(
            source: nativeContractJS(shellVersion: version),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        config.setURLSchemeHandler(nativeFiles, forURLScheme: "logsonicfile")

        let wv = WKWebView(frame: .zero, configuration: config)
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.translatesAutoresizingMaskIntoConstraints = false
        // No white/black flash before the SPA paints its own background:
        // let the window's own (appearance-matched) color show through.
        wv.setValue(false, forKey: "drawsBackground")
        if #available(macOS 12.0, *) {
            wv.underPageBackgroundColor = dark ? appBackgroundDark : appBackgroundLight
        }
        #if DEBUG
        if #available(macOS 13.3, *) {
            wv.isInspectable = true
        }
        #endif
        webView = wv

        overlay.font = .systemFont(ofSize: 15, weight: .medium)
        overlay.textColor = .secondaryLabelColor
        overlay.alignment = .center
        overlay.translatesAutoresizingMaskIntoConstraints = false

        let root = NSView()
        window.contentView = root
        root.addSubview(wv)
        root.addSubview(overlay)
        NSLayoutConstraint.activate([
            wv.topAnchor.constraint(equalTo: root.topAnchor),
            wv.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            wv.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            wv.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            overlay.centerXAnchor.constraint(equalTo: root.centerXAnchor),
            overlay.centerYAnchor.constraint(equalTo: root.centerYAnchor),
            overlay.leadingAnchor.constraint(greaterThanOrEqualTo: root.leadingAnchor, constant: 24),
            overlay.trailingAnchor.constraint(lessThanOrEqualTo: root.trailingAnchor, constant: -24),
        ])

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func makeLogWindow(title: String = "LogSonic Server Log") -> NSWindow {
        let win = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 740, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        win.title = title
        win.minSize = NSSize(width: 480, height: 240)
        win.isReleasedWhenClosed = false
        win.delegate = self

        let root = NSView()
        win.contentView = root

        let header = NSView()
        header.translatesAutoresizingMaskIntoConstraints = false
        header.addSubview(status)

        let copyLogsButton = NSButton(title: "Copy", target: self, action: #selector(copyLogs))
        copyLogsButton.isBordered = false
        copyLogsButton.font = .systemFont(ofSize: 11, weight: .medium)
        copyLogsButton.translatesAutoresizingMaskIntoConstraints = false
        copyLogsButton.attributedTitle = NSAttributedString(string: "Copy", attributes: [
            .foregroundColor: NSColor.secondaryLabelColor,
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
        ])
        self.copyLogsButton = copyLogsButton
        header.addSubview(copyLogsButton)

        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = consoleBG.cgColor
        card.layer?.cornerRadius = 8
        card.translatesAutoresizingMaskIntoConstraints = false

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        console.isEditable = false
        console.isSelectable = true
        console.drawsBackground = false
        console.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        console.textColor = consoleFG
        console.textContainerInset = NSSize(width: 12, height: 12)
        console.isVerticallyResizable = true
        console.isHorizontallyResizable = false
        console.autoresizingMask = [.width]
        console.textContainer?.widthTracksTextView = true
        scroll.documentView = console
        card.addSubview(scroll)

        root.addSubview(header)
        root.addSubview(card)
        NSLayoutConstraint.activate([
            header.topAnchor.constraint(equalTo: root.topAnchor, constant: 10),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 14),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -14),
            header.heightAnchor.constraint(equalToConstant: 22),
            status.leadingAnchor.constraint(equalTo: header.leadingAnchor),
            status.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            copyLogsButton.trailingAnchor.constraint(equalTo: header.trailingAnchor),
            copyLogsButton.centerYAnchor.constraint(equalTo: header.centerYAnchor),
            card.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 10),
            card.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -12),
            card.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -12),
            scroll.topAnchor.constraint(equalTo: card.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: card.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: card.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: card.bottomAnchor),
        ])
        return win
    }

    @objc private func toggleLogWindow() {
        if useBrowser { return }
        if let win = logWindow, win.isVisible {
            win.close()
            return
        }
        let isNewWindow = logWindow == nil
        let win = logWindow ?? makeLogWindow()
        logWindow = win
        if isNewWindow {
            // setFrameAutosaveName restores a prior session's frame and
            // reports whether it found one -- only fall back to positioning
            // under the main window when there's nothing to restore.
            let restored = win.setFrameAutosaveName("serverLog")
            if !restored {
                if let main = window {
                    var origin = main.frame.origin
                    origin.y -= 20
                    win.setFrameOrigin(origin)
                } else {
                    win.center()
                }
            }
        }
        win.makeKeyAndOrderFront(nil)
        showLogMenuItem?.state = .on
    }

    // MARK: Log streaming + coloring

    private func feed(_ s: String) {
        lineBuffer += s
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl])
            lineBuffer.removeSubrange(lineBuffer.startIndex...nl)
            emit(line + "\n")
        }
        // A child process should never emit an unbounded line. Keep malformed
        // output from growing the app indefinitely while still preserving a
        // useful prefix in the server log.
        if lineBuffer.count > maxBufferedLogLineCharacters {
            let split = lineBuffer.index(lineBuffer.startIndex, offsetBy: maxBufferedLogLineCharacters)
            emit(String(lineBuffer[..<split]) + "… [line truncated]\n")
            lineBuffer.removeSubrange(lineBuffer.startIndex..<split)
        }
    }

    private func emit(_ line: String) {
        let lower = line.lowercased()
        let color: NSColor
        if lower.contains("error") || lower.contains("failed") || lower.contains("fatal") {
            color = NSColor(srgbRed: 1, green: 0.42, blue: 0.42, alpha: 1)
        } else if lower.contains("listening") {
            color = NSColor(srgbRed: 0.45, green: 0.88, blue: 0.55, alpha: 1)
        } else if lower.contains("shutting down") || lower.contains("stopped") || lower.contains("exited")
            || lower.contains("retention") {
            color = NSColor(srgbRed: 0.98, green: 0.74, blue: 0.36, alpha: 1)
        } else {
            color = consoleFG
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
            .foregroundColor: color,
        ]
        console.textStorage?.append(NSAttributedString(string: line, attributes: attrs))
        trimConsoleIfNeeded()
        console.scrollToEndOfDocument(nil)
        detectURL(in: line)
    }

    private func trimConsoleIfNeeded() {
        guard let storage = console.textStorage, storage.length > maxConsoleCharacters else { return }
        let overflow = storage.length - trimmedConsoleCharacters
        let text = storage.string as NSString
        let searchStart = min(overflow, text.length)
        let searchLength = min(4_096, text.length - searchStart)
        let newline = text.range(of: "\n", options: [], range: NSRange(location: searchStart, length: searchLength))
        let end = newline.location == NSNotFound ? overflow : newline.location + newline.length
        storage.deleteCharacters(in: NSRange(location: 0, length: min(end, storage.length)))
        let marker = NSAttributedString(string: "[earlier server logs truncated]\n", attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular),
            .foregroundColor: NSColor.secondaryLabelColor,
        ])
        storage.insert(marker, at: 0)
    }

    private func detectURL(in line: String) {
        guard serverURL == nil, let parsedURL = parseListeningURL(from: line) else {
            if serverURL == nil, line.contains("Server listening on ") {
                emit("error: server reported an unsafe or invalid URL\n")
                overlay.isHidden = false
                overlay.stringValue = "Server reported an invalid URL"
            }
            return
        }
        let url = parsedURL.absoluteString
        serverURL = url
        parsedServerURL = parsedURL
        loadAttempts = 0
        restartCount = 0
        if let host = parsedURL.host {
            let shown = parsedURL.port.map { "\(host):\($0)" } ?? host
            status.set("Running · \(shown)", color: NSColor(srgbRed: 0.30, green: 0.80, blue: 0.44, alpha: 1))
            window.subtitle = shown
        } else {
            status.set("Running", color: .systemGreen)
        }
        if useBrowser {
            NSWorkspace.shared.open(parsedURL)
        } else {
            loadApp(url)
        }
        fetchStorageInfo(serverURL: url)
    }

    private func loadApp(_ url: String) {
        guard let u = URL(string: url), let webView else { return }
        overlay.stringValue = "Loading UI…"
        overlay.isHidden = false
        loadAttempts += 1
        webView.load(URLRequest(url: u))
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        overlay.isHidden = true
        loadAttempts = 0
        deliverPendingNativeFiles()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        handleLoadFailure(error)
    }

    private func handleLoadFailure(_ error: Error) {
        if isNavigationCancelError(error) { return }
        if let url = serverURL, loadAttempts < 8 {
            overlay.stringValue = "Retrying UI…"
            overlay.isHidden = false
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25 * Double(loadAttempts)) { [weak self] in
                self?.loadApp(url)
            }
            return
        }
        overlay.isHidden = false
        overlay.stringValue = "Failed to load UI: \(error.localizedDescription)"
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let server = parsedServerURL else {
            decisionHandler(.cancel)
            return
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if #available(macOS 11.3, *), navigationAction.shouldPerformDownload, isServerOrigin(url, serverURL: server) || isServerBlob(url, serverURL: server) {
            decisionHandler(.download)
            return
        }

        if scheme == "http" || scheme == "https" {
            if isServerOrigin(url, serverURL: server) {
                if navigationAction.targetFrame == nil {
                    webView.load(URLRequest(url: url))
                    decisionHandler(.cancel)
                    return
                }
                decisionHandler(.allow)
            } else {
                NSWorkspace.shared.open(url)
                decisionHandler(.cancel)
            }
            return
        }

        if isAllowedAboutURL(url) || isServerBlob(url, serverURL: server) {
            decisionHandler(.allow)
            return
        }
        if scheme == "logsonicfile" {
            decisionHandler(.allow)
            return
        }

        if ["mailto", "tel"].contains(scheme), NSWorkspace.shared.open(url) {
            decisionHandler(.cancel)
            return
        }

        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        guard let url = navigationResponse.response.url, let server = parsedServerURL,
              isServerOrigin(url, serverURL: server) || isServerBlob(url, serverURL: server) else {
            decisionHandler(.cancel)
            return
        }
        if !navigationResponse.canShowMIMEType {
            if #available(macOS 11.3, *) {
                decisionHandler(.download)
            } else {
                // WKDownload was added in macOS 11.3. Earlier systems can use
                // View -> Open in Browser for downloads.
                decisionHandler(.cancel)
                openInBrowser()
            }
            return
        }
        decisionHandler(.allow)
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    @available(macOS 11.3, *)
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    // MARK: WKUIDelegate

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, let server = parsedServerURL {
            if isServerOrigin(url, serverURL: server) {
                webView.load(URLRequest(url: url))
            } else if ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentJavaScriptAlert(message: message, buttons: ["OK"]) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentJavaScriptAlert(message: message, buttons: ["OK", "Cancel"]) { response in
            completionHandler(response == .alertFirstButtonReturn)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(string: defaultText ?? "")
        let alert = NSAlert()
        alert.messageText = "LogSonic"
        alert.informativeText = prompt
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in
            completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }

    private func presentJavaScriptAlert(message: String, buttons: [String], completion: @escaping (NSApplication.ModalResponse) -> Void) {
        let alert = NSAlert()
        alert.messageText = "LogSonic"
        alert.informativeText = message
        for button in buttons {
            alert.addButton(withTitle: button)
        }
        alert.beginSheetModal(for: window, completionHandler: completion)
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        DispatchQueue.main.async {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = parameters.allowsDirectories
            panel.canChooseFiles = true
            panel.begin { result in
                completionHandler(result == .OK ? panel.urls : nil)
            }
        }
    }

    // MARK: WKDownloadDelegate

    @available(macOS 11.3, *)
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        DispatchQueue.main.async {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = sanitizedDownloadName(suggestedFilename)
            panel.begin { result in
                completionHandler(result == .OK ? panel.url : nil)
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        switch message.name {
        case "logsonicDownload":
            handleDownloadMessage(message)
        case "logsonicDrag":
            handleDragMessage(message)
        case "logsonicTheme":
            handleThemeMessage(message)
        default:
            break
        }
    }

    private func handleDownloadMessage(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let dataB64 = body["data"] as? String,
              let data = Data(base64Encoded: dataB64) else { return }
        let name = sanitizedDownloadName(body["filename"] as? String ?? "download")
        DispatchQueue.main.async {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = name
            panel.begin { result in
                guard result == .OK, let url = panel.url else { return }
                try? data.write(to: url, options: .atomic)
            }
        }
    }

    // dragStripHookJS has already confirmed the mousedown was in the strip
    // and on a non-interactive target -- this only needs to decide drag vs.
    // zoom (dragStripAction's y/stripHeight branches are exercised by its
    // unit tests, not by this already-filtered call site).
    private func handleDragMessage(_ message: WKScriptMessage) {
        let clickCount = (message.body as? [String: Any])?["clickCount"] as? Int ?? 1
        let action = dragStripAction(y: 0, stripHeight: dragStripHeight, targetIsInteractive: false, clickCount: clickCount)
        switch action {
        case .zoom:
            window.zoom(nil)
        case .drag:
            // performDrag(with:) requires a genuine mouse-down NSEvent for
            // this window; NSApp.currentEvent by the time this IPC message
            // arrives is not reliable (see lastMouseDown's declaration).
            guard let event = lastMouseDown, event.window === window else { return }
            window.performDrag(with: event)
        case .none:
            break
        }
    }

    // The page calls window.__logsonicNotifyTheme (see useThemeStore.ts)
    // whenever its resolved theme changes, including an explicit user choice
    // that isn't following the system -- keeps the window background (which
    // paints before the SPA does, e.g. on resize) in sync either way.
    private func handleThemeMessage(_ message: WKScriptMessage) {
        guard let effective = message.body as? String else { return }
        let dark = effective == "dark"
        applyBackgroundColor(dark: dark)
    }

    private func applyBackgroundColor(dark: Bool) {
        window.backgroundColor = dark ? appBackgroundDark : appBackgroundLight
        if #available(macOS 12.0, *) {
            webView?.underPageBackgroundColor = dark ? appBackgroundDark : appBackgroundLight
        }
    }

    private func isDarkAppearance(_ appearance: NSAppearance) -> Bool {
        appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }

    // Observes NSApp.effectiveAppearance (System Settings' light/dark/auto)
    // and pushes it into the page so a theme in 'auto' mode follows it live,
    // plus updates the window/webview background directly and immediately
    // (not waiting on the page's own JS round trip).
    private func observeAppearance() {
        applyBackgroundColor(dark: isDarkAppearance(NSApp.effectiveAppearance))
        appearanceObservation = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, change in
            guard let self, let appearance = change.newValue else { return }
            let dark = self.isDarkAppearance(appearance)
            DispatchQueue.main.async {
                self.applyBackgroundColor(dark: dark)
                self.webView?.evaluateJavaScript(
                    "window.__logsonicSetSystemAppearance && window.__logsonicSetSystemAppearance('\(dark ? "dark" : "light")');"
                )
            }
        }
    }

    private func fetchStorageInfo(serverURL: String, attempt: Int = 0) {
        guard let url = URL(string: "\(serverURL)/api/v1/info") else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            if let data, ok,
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let storageInfo = json["storage_info"] as? [String: Any],
               let dir = storageInfo["storage_directory"] as? String {
                DispatchQueue.main.async { self?.storageDir = dir }
                return
            }
            if attempt < 8 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    self?.fetchStorageInfo(serverURL: serverURL, attempt: attempt + 1)
                }
            }
        }.resume()
    }

    @objc private func revealInFinder() {
        guard let dir = storageDir else { return }
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir)
    }

    @objc private func openInBrowser() {
        if let s = serverURL, let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }

    @objc private func reloadUI() {
        if useBrowser {
            openInBrowser()
            return
        }
        if let webView, webView.url != nil {
            webView.reload()
        } else if let s = serverURL {
            loadApp(s)
        }
    }

    @objc private func copyURL() {
        guard let s = serverURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
    }

    @objc private func copyLogs() {
        let text = console.string
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        if let b = copyLogsButton { flashLight(b, "Copied") }
    }

    private func flashLight(_ button: NSButton, _ text: String) {
        let restore = button.attributedTitle
        button.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: NSColor(srgbRed: 0.45, green: 0.88, blue: 0.55, alpha: 1),
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { button.attributedTitle = restore }
    }

    private func acquireInstanceLock() -> Bool {
        let id = Bundle.main.bundleIdentifier ?? "com.logsonic.app"
        let path = lockFileURL(bundleIdentifier: id).path
        let fd = open(path, O_CREAT | O_RDWR, 0o644)
        if fd < 0 { return true }
        if flock(fd, LOCK_EX | LOCK_NB) != 0 {
            close(fd)
            return false
        }
        lockFD = fd
        return true
    }

    private func activateExistingInstance() {
        let id = Bundle.main.bundleIdentifier ?? "com.logsonic.app"
        NSRunningApplication.runningApplications(withBundleIdentifier: id)
            .first { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }?
            .activate(options: [.activateIgnoringOtherApps])
    }

    private func openNativeFiles(_ filenames: [String]) {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        guard !useBrowser else {
            filenames.prefix(8).forEach { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: $0)]) }
            return
        }
        // now-08: hand over absolute paths, not logsonicfile:// URLs -- no
        // per-file registration, no extension guard (the server sniffs
        // gzip/zstd by magic bytes and rejects what it can't read), no size
        // cap (that was only needed for the old whole-file in-memory read).
        // A path whose stat fails (e.g. a temp file already cleaned up by
        // whatever handed it to us) is dropped here rather than forwarded
        // to a server round trip that can only reject it.
        var paths: [String] = []
        var mtimes: [String?] = []
        for path in filenames {
            guard let attrs = try? FileManager.default.attributesOfItem(atPath: path) else { continue }
            paths.append(path)
            if let date = attrs[.modificationDate] as? Date {
                mtimes.append(ISO8601DateFormatter().string(from: date))
            } else {
                mtimes.append(nil)
            }
        }
        guard !paths.isEmpty, webView != nil else { return }
        pendingNativeFilePayloads.append((paths: paths, mtimes: mtimes))
        deliverPendingNativeFiles()
    }

    private func deliverPendingNativeFiles() {
        guard serverURL != nil, let webView, !webView.isLoading, !pendingNativeFilePayloads.isEmpty else { return }
        let payloads = pendingNativeFilePayloads
        pendingNativeFilePayloads.removeAll()
        for payload in payloads {
            deliverNativePaths(payload.paths, mtimes: payload.mtimes, in: webView)
        }
    }

    private func deliverNativePaths(_ paths: [String], mtimes: [String?], in webView: WKWebView) {
        let pathsJSON = (try? JSONSerialization.data(withJSONObject: paths)).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        // NSNull round-trips through JSONSerialization as JSON null, unlike a
        // Swift Optional, which JSONSerialization refuses to serialize at all.
        let mtimesJSON = (try? JSONSerialization.data(withJSONObject: mtimes.map { ($0 as Any?) ?? NSNull() })).flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let js = """
        window.__logsonicPendingNativeFiles = {paths: \(pathsJSON), mtimes: \(mtimesJSON)};
        window.location.hash = '#/import';
        window.dispatchEvent(new CustomEvent('logsonic-native-files', {detail: window.__logsonicPendingNativeFiles}));
        """
        webView.evaluateJavaScript(js, completionHandler: nil)
    }

    // MARK: Server child process

    private func startServer() {
        guard let exe = Bundle.main.executableURL else {
            emit("error: cannot locate bundle executable\n")
            overlay.stringValue = "Cannot locate bundle executable"
            return
        }
        let serverPath = exe.deletingLastPathComponent().appendingPathComponent("logsonic")
        guard FileManager.default.isExecutableFile(atPath: serverPath.path) else {
            emit("error: bundled server is missing or not executable: \(serverPath.path)\n")
            status.set("Stopped", color: .systemRed)
            overlay.stringValue = "Bundled server is missing"
            toggleLogWindowIfHidden()
            return
        }

        let p = Process()
        p.executableURL = serverPath
        // The local API has no network authentication. A desktop launch must
        // never inherit HOST=0.0.0.0 (or another LAN interface) from the user's
        // shell. Users who intentionally need a network listener can run the
        // separately installed CLI.
        p.arguments = ["-host", "127.0.0.1", "-auto-port=true"]
        var env = ProcessInfo.processInfo.environment
        env["LOGSONIC_AUTO_PORT"] = "1"                   // pick a free port if 8080 is busy
        env["LOGSONIC_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)
        env.removeValue(forKey: "LOGSONIC_APP")           // GUI owns app behavior
        env.removeValue(forKey: "LOGSONIC_OPEN_BROWSER")  // shell opens the browser when --browser
        env.removeValue(forKey: "LOGSONIC_BROWSER")
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            if data.isEmpty {
                h.readabilityHandler = nil
                return
            }
            let s = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.feed(s) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self else { return }
                pipe.fileHandleForReading.readabilityHandler = nil
                if !self.lineBuffer.isEmpty { self.emit(self.lineBuffer + "\n"); self.lineBuffer = "" }
                self.emit("\n[server exited: status \(proc.terminationStatus)]\n")
                if !self.quitting {
                    self.serverURL = nil
                    self.parsedServerURL = nil
                    if self.restartCount < maxServerRestarts {
                        self.restartCount += 1
                        self.status.set("Restarting…", color: .systemOrange)
                        self.overlay.isHidden = false
                        self.overlay.stringValue = "Server stopped — restarting (\(self.restartCount)/\(maxServerRestarts))"
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                            guard let self, !self.quitting else { return }
                            self.startServer()
                        }
                        return
                    }
                    self.status.set("Stopped", color: .systemRed)
                    if !self.useBrowser {
                        self.overlay.isHidden = false
                        self.overlay.stringValue = "Server stopped"
                    }
                    self.toggleLogWindowIfHidden()
                }
            }
        }
        do {
            try p.run()
            process = p
        } catch {
            emit("error: failed to start server: \(error)\n")
            status.set("Stopped", color: .systemRed)
            overlay.stringValue = "Failed to start server"
            toggleLogWindowIfHidden()
        }
    }

    private func toggleLogWindowIfHidden() {
        if logWindow == nil || logWindow?.isVisible == false {
            toggleLogWindow()
        }
    }

    // Quit / window-close → ask the server to shut down gracefully (it handles
    // SIGINT), wait slightly longer than its 30-second drain timeout, then
    // escalate to SIGTERM and finally SIGKILL so the app cannot orphan a server.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let p = process, p.isRunning, !quitting else { return .terminateNow }
        quitting = true
        status.set("Shutting down…", color: .systemOrange)
        emit("\nShutting down…\n")
        p.interrupt() // SIGINT
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(35)
            while p.isRunning && Date() < deadline { usleep(100_000) }
            if p.isRunning {
                p.terminate() // SIGTERM fallback
                let termDeadline = Date().addingTimeInterval(5)
                while p.isRunning && Date() < termDeadline { usleep(100_000) }
            }
            if p.isRunning {
                kill(p.processIdentifier, SIGKILL)
                p.waitUntilExit()
            }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

@main
enum LogsonicMain {
    static func main() {
        if CommandLine.arguments.contains(where: { $0 == "--help" || $0 == "-h" || $0 == "-help" }) {
            let msg = """
            Logsonic.app — native macOS shell for LogSonic.

              LogsonicApp [--browser]

              --browser, -browser   Open the UI in the default browser instead of the in-app window
              LOGSONIC_BROWSER=1    Same as --browser

            To run without this app at all: logsonic -open

            """
            fputs(msg, stderr)
            exit(0)
        }

        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.setActivationPolicy(.regular) // show the Dock icon
        app.run()
    }
}
