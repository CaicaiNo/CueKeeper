import AppKit
import CoreGraphics
import QuartzCore

@MainActor
final class RecordingIndicator {
    enum Visibility {
        case waiting(String)
        case confirmed([String: Any])
    }

    enum Mode {
        case recording
        case replay
    }

    private let mode: Mode
    private var panel: IndicatorPanel?
    private var displayID = CGMainDisplayID()

    init(mode: Mode = .recording) {
        self.mode = mode
    }

    func show() -> String? {
        hide()
        displayID = CGMainDisplayID()
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[key] as? NSNumber)?.uint32Value == displayID
        }) else { return "Primary display is unavailable to AppKit" }
        guard let panel = IndicatorPanel(screen: screen, mode: mode) else {
            return "AppKit did not create the indicator backing layer"
        }
        self.panel = panel
        // `show()` only runs at the helper's ready moment, so the very first
        // frame already reads as a running capture rather than a warm-up.
        panel.update(text: IndicatorLabel.text(mode: indicatorLabelMode, elapsed: 0,
                                               paused: false, starting: false),
                     paused: false, starting: false)
        panel.orderFrontRegardless()
        panel.displayIfNeeded()
        CATransaction.flush()
        return nil
    }

    func visibility() -> Visibility {
        guard let panel else { return .waiting("Primary panel was not created") }
        guard panel.isVisible, panel.windowNumber > 0 else { return .waiting("AppKit did not order the primary panel") }
        guard let windows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else {
            return .waiting("Window Server did not return on-screen windows")
        }
        let pid = ProcessInfo.processInfo.processIdentifier
        guard let info = windows.first(where: {
            ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == panel.windowNumber &&
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid
        }) else { return .waiting("Primary panel is missing from the Window Server on-screen list") }
        guard let level = (info[kCGWindowLayer as String] as? NSNumber)?.intValue,
              level >= NSWindow.Level.statusBar.rawValue else {
            return .waiting("Primary panel layer is below the status bar level")
        }
        guard let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary) else {
            return .waiting("Window Server did not return primary panel bounds")
        }
        let expected = CGDisplayBounds(displayID)
        let frame = [bounds.minX, bounds.minY, bounds.width, bounds.height]
        let screen = [expected.minX, expected.minY, expected.width, expected.height]
        guard zip(frame, screen).allSatisfy({ abs($0.0 - $0.1) <= 1 }) else {
            return .waiting("Primary panel bounds \(frame) do not match display bounds \(screen)")
        }
        return .confirmed(["window": panel.windowNumber, "display": displayID, "level": level, "bounds": frame])
    }

    func update(elapsed: Int, paused: Bool, starting: Bool) {
        panel?.update(text: IndicatorLabel.text(mode: indicatorLabelMode, elapsed: elapsed,
                                                paused: paused, starting: starting),
                      paused: paused, starting: starting)
    }

    private var indicatorLabelMode: IndicatorLabel.Mode {
        mode == .replay ? .replay : .recording
    }

    func covers(_ point: NSPoint) -> Bool {
        panel?.covers(point) == true
    }

    func hide() {
        panel?.orderOut(nil)
        panel = nil
    }
}

@MainActor
private final class IndicatorPanel: NSPanel {
    private static let recordingAccent = NSColor(srgbRed: 1, green: 0.24, blue: 0.34, alpha: 1)
    private static let replayAccent = NSColor(srgbRed: 0.24, green: 0.62, blue: 1, alpha: 1)
    private let accent: NSColor
    private let mode: RecordingIndicator.Mode
    /// The glow reaches this far inside the screen edge. Static, gradient-only.
    private let glowWidth: CGFloat = 48
    private let hud: NSRect
    private let label = NSTextField(labelWithString: "")
    private var glow: [CAGradientLayer] = []
    private let badge = CALayer()
    private let dot = CALayer()

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init?(screen: NSScreen, mode: RecordingIndicator.Mode) {
        self.mode = mode
        self.accent = mode == .replay ? Self.replayAccent : Self.recordingAccent
        let frame = screen.frame
        let size = frame.size
        let hudWidth = min(380, size.width - 20)
        hud = NSRect(x: (size.width - hudWidth) / 2, y: screen.visibleFrame.maxY - frame.minY - 58,
                     width: hudWidth, height: 46)
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        // A remote desktop (ToDesk, Screen Sharing) hands the operator a screen
        // capture, so a window excluded from capture is invisible there while the
        // recording keeps running. CueKeeper records accessibility events, never
        // pixels, so staying capturable cannot leak the indicator into a flow.
        // CUEKEEPER_INDICATOR_HIDDEN=1 restores the old exclusion for a clean demo.
        sharingType = ProcessInfo.processInfo.environment["CUEKEEPER_INDICATOR_HIDDEN"] == "1"
            ? .none : .readOnly
        level = .statusBar
        collectionBehavior = [.ignoresCycle]
        setFrame(frame, display: false)

        let view = NSView(frame: NSRect(origin: .zero, size: size))
        contentView = view
        view.wantsLayer = true
        guard let backing = view.layer else { return nil }

        // A static edge gradient replaces the old solid border. It is twice the
        // old particle spread and fades inward, so no animation is needed.
        glow = Self.edgeGlow(accent: accent, size: size, width: glowWidth)
        for layer in glow { backing.addSublayer(layer) }

        badge.frame = hud
        badge.cornerRadius = 14
        badge.borderWidth = 1
        badge.borderColor = accent.cgColor
        dot.frame = CGRect(x: 16, y: 18, width: 10, height: 10)
        dot.cornerRadius = 5
        dot.backgroundColor = accent.cgColor
        badge.addSublayer(dot)
        backing.addSublayer(badge)

        label.frame = NSRect(x: hud.minX + 32, y: hud.midY - 9, width: hud.width - 48, height: 20)
        label.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        label.textColor = mode == .replay ? accent : .white
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.55)
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        label.shadow = shadow
        label.alignment = .center
        view.addSubview(label)
    }

    private static func edgeGlow(accent: NSColor, size: CGSize, width: CGFloat) -> [CAGradientLayer] {
        let edge = accent.withAlphaComponent(0.62).cgColor
        let mid = accent.withAlphaComponent(0.16).cgColor
        let clear = accent.withAlphaComponent(0).cgColor
        func strip(_ frame: CGRect, _ start: CGPoint, _ end: CGPoint) -> CAGradientLayer {
            let layer = CAGradientLayer()
            layer.frame = frame
            layer.colors = [edge, mid, clear]
            layer.locations = [0, 0.4, 1]
            layer.startPoint = start
            layer.endPoint = end
            return layer
        }
        return [
            strip(CGRect(x: 0, y: size.height - width, width: size.width, height: width),
                  CGPoint(x: 0.5, y: 1), CGPoint(x: 0.5, y: 0)),
            strip(CGRect(x: 0, y: 0, width: size.width, height: width),
                  CGPoint(x: 0.5, y: 0), CGPoint(x: 0.5, y: 1)),
            strip(CGRect(x: 0, y: 0, width: width, height: size.height),
                  CGPoint(x: 0, y: 0.5), CGPoint(x: 1, y: 0.5)),
            strip(CGRect(x: size.width - width, y: 0, width: width, height: size.height),
                  CGPoint(x: 1, y: 0.5), CGPoint(x: 0, y: 0.5)),
        ]
    }

    func update(text: String, paused: Bool, starting: Bool) {
        if label.stringValue != text { label.stringValue = text }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if mode == .replay {
            // Replay stays ambient but keeps a legible translucent plate.
            badge.backgroundColor = NSColor(white: 0.05, alpha: 0.38).cgColor
            badge.borderWidth = 0.5
            badge.borderColor = accent.withAlphaComponent(0.45).cgColor
        } else {
            badge.backgroundColor = starting
                ? accent.withAlphaComponent(0.22).cgColor
                : NSColor(white: 0.08, alpha: 0.98).cgColor
            badge.borderWidth = starting ? 2 : 1
        }
        dot.opacity = paused ? 0.4 : 1
        // A paused recording keeps a faint edge; a replay always shows the glow.
        for layer in glow { layer.opacity = mode == .replay ? 1 : (paused ? 0.35 : 1) }
        CATransaction.commit()
    }

    func covers(_ point: NSPoint) -> Bool {
        guard frame.contains(point) else { return false }
        let local = convertPoint(fromScreen: point)
        return hud.contains(local)
    }
}
