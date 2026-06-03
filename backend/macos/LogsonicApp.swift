// LogsonicApp — the native macOS GUI shell for Logsonic.app.
//
// Why this exists: the Logsonic server is a plain Go HTTP binary with no Cocoa
// event loop. Launched directly from a .app bundle it has no Dock presence and
// macOS flags it "not responding" (Force Quit only — a SIGKILL with no graceful
// shutdown). This AppKit shell is the bundle's CFBundleExecutable instead: it
// shows the responsive LogSonic Dock icon and a small status window, runs the Go
// server (Contents/MacOS/logsonic) as a child, streams its log output, opens the
// web UI, and on Quit / window-close sends the child SIGINT so it drains the
// HTTP server and closes its indices cleanly.
//
// Build (universal) — see scripts/app-macos.sh:
//   swiftc -O -target arm64-apple-macos11  LogsonicApp.swift -o app-arm64
//   swiftc -O -target x86_64-apple-macos11 LogsonicApp.swift -o app-x86_64
//   lipo -create app-arm64 app-x86_64 -o LogsonicApp

import AppKit
import Foundation

// LogSonic brand purple (#6d5dfc), matching the app icon.
let brandColor = NSColor(srgbRed: 0x6D / 255.0, green: 0x5D / 255.0, blue: 0xFC / 255.0, alpha: 1)
let consoleBG = NSColor(srgbRed: 0x17 / 255.0, green: 0x17 / 255.0, blue: 0x1F / 255.0, alpha: 1)
let consoleFG = NSColor(srgbRed: 0xCF / 255.0, green: 0xD2 / 255.0, blue: 0xDC / 255.0, alpha: 1)

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
        // Soft glow ring around the dot.
        dot.layer?.shadowColor = color.cgColor
        dot.layer?.shadowOpacity = 0.9
        dot.layer?.shadowRadius = 3
        dot.layer?.shadowOffset = .zero
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var window: NSWindow!
    private let console = NSTextView()
    private let status = StatusPill()
    private let urlField = NSTextField(labelWithString: "Starting…")
    private var openButton: NSButton!
    private var copyButton: NSButton!
    private var copyLogsButton: NSButton!

    private var process: Process?
    private var serverURL: String?
    private var lineBuffer = ""
    private var quitting = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        status.set("Starting…", color: .systemOrange)
        startServer()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

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

        // Edit menu — the standard selectors route to the first responder (the
        // console text view), so ⌘C / ⌘A and right-click → Copy work on the logs.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Copy All Logs", action: #selector(copyLogs), keyEquivalent: "C")
        editItem.submenu = editMenu

        NSApp.mainMenu = mainMenu
    }

    private func brandBadge() -> NSView {
        let badge = NSView()
        badge.wantsLayer = true
        badge.layer?.backgroundColor = brandColor.cgColor
        badge.layer?.cornerRadius = 8
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.layer?.shadowColor = brandColor.cgColor
        badge.layer?.shadowOpacity = 0.5
        badge.layer?.shadowRadius = 6
        badge.layer?.shadowOffset = NSSize(width: 0, height: -1)

        let glyph: NSView
        let cfg = NSImage.SymbolConfiguration(pointSize: 17, weight: .bold)
        if let img = NSImage(systemSymbolName: "bolt.fill", accessibilityDescription: "LogSonic")?
            .withSymbolConfiguration(cfg) {
            let iv = NSImageView(image: img)
            iv.contentTintColor = .white
            glyph = iv
        } else {
            let l = NSTextField(labelWithString: "⚡")
            l.font = .systemFont(ofSize: 16, weight: .bold)
            l.textColor = .white
            glyph = l
        }
        glyph.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(glyph)
        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 32),
            badge.heightAnchor.constraint(equalToConstant: 32),
            glyph.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            glyph.centerYAnchor.constraint(equalTo: badge.centerYAnchor),
        ])
        return badge
    }

    private func makeButton(_ title: String, action: Selector, target: AnyObject, primary: Bool = false) -> NSButton {
        let b = NSButton(title: title, target: target, action: action)
        b.bezelStyle = .rounded
        b.controlSize = .large
        b.translatesAutoresizingMaskIntoConstraints = false
        if primary {
            b.bezelColor = brandColor
            b.contentTintColor = .white
            b.keyEquivalent = "\r"
        }
        return b
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 740, height: 520),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "LogSonic"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 560, height: 380)
        window.center()
        window.isReleasedWhenClosed = false
        let root = NSView()
        window.contentView = root

        // --- Header (sits under the transparent titlebar; cleared past traffic lights) ---
        let header = NSVisualEffectView()
        header.material = .headerView
        header.blendingMode = .behindWindow
        header.translatesAutoresizingMaskIntoConstraints = false

        let badge = brandBadge()
        let titleLabel = NSTextField(labelWithString: "LogSonic")
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.textColor = .labelColor
        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        let subtitle = NSTextField(labelWithString: "Log analytics")
        subtitle.font = .systemFont(ofSize: 11, weight: .regular)
        subtitle.textColor = .tertiaryLabelColor
        subtitle.translatesAutoresizingMaskIntoConstraints = false

        header.addSubview(badge)
        header.addSubview(titleLabel)
        header.addSubview(subtitle)
        header.addSubview(status)

        // --- Console (dark, rounded, inset) with a title bar ---
        let card = NSView()
        card.wantsLayer = true
        card.layer?.backgroundColor = consoleBG.cgColor
        card.layer?.cornerRadius = 10
        card.layer?.borderWidth = 1
        card.layer?.borderColor = NSColor.black.withAlphaComponent(0.25).cgColor
        card.translatesAutoresizingMaskIntoConstraints = false

        let consoleLabel = NSTextField(labelWithString: "Console")
        consoleLabel.font = .systemFont(ofSize: 11, weight: .semibold)
        consoleLabel.textColor = NSColor(white: 0.55, alpha: 1)
        consoleLabel.translatesAutoresizingMaskIntoConstraints = false

        let copyLogsButton = NSButton(title: "Copy", target: self, action: #selector(copyLogs))
        copyLogsButton.isBordered = false
        copyLogsButton.font = .systemFont(ofSize: 11, weight: .medium)
        copyLogsButton.contentTintColor = NSColor(white: 0.7, alpha: 1)
        copyLogsButton.translatesAutoresizingMaskIntoConstraints = false
        if let img = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "Copy logs") {
            copyLogsButton.image = img
            copyLogsButton.imagePosition = .imageLeading
            copyLogsButton.imageHugsTitle = true
        }
        copyLogsButton.attributedTitle = NSAttributedString(string: "Copy", attributes: [
            .foregroundColor: NSColor(white: 0.7, alpha: 1),
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
        ])
        self.copyLogsButton = copyLogsButton

        let divider = NSBox()
        divider.boxType = .separator
        divider.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(consoleLabel)
        card.addSubview(copyLogsButton)
        card.addSubview(divider)

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.automaticallyAdjustsContentInsets = false
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

        // --- Footer (URL + actions) ---
        let footer = NSVisualEffectView()
        footer.material = .titlebar
        footer.blendingMode = .behindWindow
        footer.translatesAutoresizingMaskIntoConstraints = false

        let linkIcon = NSImageView(image: NSImage(systemSymbolName: "link", accessibilityDescription: nil) ?? NSImage())
        linkIcon.contentTintColor = .tertiaryLabelColor
        linkIcon.translatesAutoresizingMaskIntoConstraints = false
        urlField.font = .monospacedSystemFont(ofSize: 12, weight: .medium)
        urlField.textColor = .secondaryLabelColor
        urlField.lineBreakMode = .byTruncatingMiddle
        urlField.translatesAutoresizingMaskIntoConstraints = false
        // Keep the URL at its natural width so the Copy button hugs it; truncate
        // (rather than push the button away) if the window gets narrow.
        urlField.setContentHuggingPriority(.required, for: .horizontal)
        urlField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        copyButton = makeButton("Copy", action: #selector(copyURL), target: self)
        copyButton.isEnabled = false
        openButton = makeButton("Open in Browser", action: #selector(openInBrowser), target: self, primary: true)
        openButton.isEnabled = false
        let quitButton = makeButton("Quit", action: #selector(NSApplication.terminate(_:)), target: NSApp)

        footer.addSubview(linkIcon)
        footer.addSubview(urlField)
        footer.addSubview(copyButton)
        footer.addSubview(openButton)
        footer.addSubview(quitButton)

        root.addSubview(header)
        root.addSubview(card)
        root.addSubview(footer)

        NSLayoutConstraint.activate([
            // Header — brand sits BELOW the traffic lights, aligned to the left margin.
            header.topAnchor.constraint(equalTo: root.topAnchor),
            header.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            header.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            header.heightAnchor.constraint(equalToConstant: 84),
            badge.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 18),
            badge.topAnchor.constraint(equalTo: header.topAnchor, constant: 38), // clear the traffic lights
            titleLabel.leadingAnchor.constraint(equalTo: badge.trailingAnchor, constant: 10),
            titleLabel.topAnchor.constraint(equalTo: badge.topAnchor, constant: -1),
            subtitle.leadingAnchor.constraint(equalTo: titleLabel.leadingAnchor),
            subtitle.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 1),
            status.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -16),
            status.centerYAnchor.constraint(equalTo: badge.centerYAnchor),

            // Console card
            card.topAnchor.constraint(equalTo: header.bottomAnchor, constant: 12),
            card.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 16),
            card.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -16),
            // Console title bar
            consoleLabel.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 12),
            consoleLabel.topAnchor.constraint(equalTo: card.topAnchor, constant: 9),
            copyLogsButton.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -10),
            copyLogsButton.centerYAnchor.constraint(equalTo: consoleLabel.centerYAnchor),
            divider.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 1),
            divider.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -1),
            divider.topAnchor.constraint(equalTo: consoleLabel.bottomAnchor, constant: 8),
            scroll.topAnchor.constraint(equalTo: divider.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 1),
            scroll.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -1),
            scroll.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -1),

            // Footer
            footer.topAnchor.constraint(equalTo: card.bottomAnchor, constant: 12),
            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor),
            footer.heightAnchor.constraint(equalToConstant: 60),
            // Left group: link icon + URL + Copy (Copy sits right next to the link).
            linkIcon.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 18),
            linkIcon.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            linkIcon.widthAnchor.constraint(equalToConstant: 14),
            urlField.leadingAnchor.constraint(equalTo: linkIcon.trailingAnchor, constant: 7),
            urlField.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            copyButton.leadingAnchor.constraint(equalTo: urlField.trailingAnchor, constant: 8),
            copyButton.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            copyButton.trailingAnchor.constraint(lessThanOrEqualTo: openButton.leadingAnchor, constant: -16),
            // Right group: Open in Browser + Quit.
            quitButton.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -16),
            quitButton.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
            openButton.trailingAnchor.constraint(equalTo: quitButton.leadingAnchor, constant: -8),
            openButton.centerYAnchor.constraint(equalTo: footer.centerYAnchor),
        ])

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: Log streaming + coloring

    private func feed(_ s: String) {
        lineBuffer += s
        while let nl = lineBuffer.firstIndex(of: "\n") {
            let line = String(lineBuffer[..<nl])
            lineBuffer.removeSubrange(lineBuffer.startIndex...nl)
            emit(line + "\n")
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
        console.scrollToEndOfDocument(nil)
        detectURL(in: line)
    }

    // The server prints "Server listening on http://localhost:PORT" once bound.
    private func detectURL(in line: String) {
        guard serverURL == nil, line.contains("listening"), let r = line.range(of: "http://") else { return }
        let url = line[r.lowerBound...].trimmingCharacters(in: .whitespacesAndNewlines)
        serverURL = url
        urlField.stringValue = url
        urlField.textColor = brandColor
        copyButton.isEnabled = true
        openButton.isEnabled = true
        if let host = url.range(of: "//").map({ String(url[$0.upperBound...]) }) {
            status.set("Running · \(host)", color: NSColor(srgbRed: 0.30, green: 0.80, blue: 0.44, alpha: 1))
        } else {
            status.set("Running", color: .systemGreen)
        }
        if let u = URL(string: url) { NSWorkspace.shared.open(u) }
    }

    @objc private func openInBrowser() {
        if let s = serverURL, let u = URL(string: s) { NSWorkspace.shared.open(u) }
    }

    @objc private func copyURL() {
        guard let s = serverURL else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        flash(copyButton, "Copied")
    }

    @objc private func copyLogs() {
        let text = console.string
        guard !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        flashLight(copyLogsButton, "Copied")
    }

    // Briefly swap a button's title to give copy feedback, then restore it.
    private func flash(_ button: NSButton, _ text: String) {
        let original = button.title
        button.title = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { button.title = original }
    }

    private func flashLight(_ button: NSButton, _ text: String) {
        let restore = button.attributedTitle
        button.attributedTitle = NSAttributedString(string: text, attributes: [
            .foregroundColor: NSColor(srgbRed: 0.45, green: 0.88, blue: 0.55, alpha: 1),
            .font: NSFont.systemFont(ofSize: 11, weight: .semibold),
        ])
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { button.attributedTitle = restore }
    }

    // MARK: Server child process

    private func startServer() {
        guard let exe = Bundle.main.executableURL else {
            emit("error: cannot locate bundle executable\n")
            return
        }
        let serverPath = exe.deletingLastPathComponent().appendingPathComponent("logsonic")

        let p = Process()
        p.executableURL = serverPath
        var env = ProcessInfo.processInfo.environment
        env["LOGSONIC_AUTO_PORT"] = "1"                   // pick a free port if 8080 is busy
        env.removeValue(forKey: "LOGSONIC_APP")           // GUI owns app behavior
        env.removeValue(forKey: "LOGSONIC_OPEN_BROWSER")  // GUI opens the browser
        p.environment = env

        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async { self?.feed(s) }
        }
        p.terminationHandler = { [weak self] proc in
            DispatchQueue.main.async {
                guard let self = self else { return }
                pipe.fileHandleForReading.readabilityHandler = nil
                if !self.lineBuffer.isEmpty { self.emit(self.lineBuffer + "\n"); self.lineBuffer = "" }
                self.emit("\n[server exited: status \(proc.terminationStatus)]\n")
                if !self.quitting {
                    self.status.set("Stopped", color: .systemRed)
                    self.openButton.isEnabled = false
                    self.copyButton.isEnabled = false
                }
            }
        }
        do {
            try p.run()
            process = p
        } catch {
            emit("error: failed to start server: \(error)\n")
            status.set("Stopped", color: .systemRed)
        }
    }

    // Quit / window-close → ask the server to shut down gracefully (it handles
    // SIGINT), wait up to 30s, then finish terminating.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let p = process, p.isRunning, !quitting else { return .terminateNow }
        quitting = true
        status.set("Shutting down…", color: .systemOrange)
        emit("\nShutting down…\n")
        p.interrupt() // SIGINT
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(30)
            while p.isRunning && Date() < deadline { usleep(100_000) }
            if p.isRunning { p.terminate() } // SIGTERM fallback
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular) // show the Dock icon
app.run()
