import AppKit
import CoreGraphics
import QuartzCore

/// Places the HUD's status dot and its text as one group inside the plate.
/// Kept as plain functions with no side effects so the offline tests compile
/// this file directly and assert the same placement the panel uses.
///
/// The rule is: the dot and the text are one piece. Their combined width is
/// centred on the plate, the gap between them is fixed, and both are centred
/// vertically on the plate's midline.
enum IndicatorLayout {
    struct Frames: Equatable {
        let dot: CGRect
        let label: CGRect
    }

    /// Diameter of the status dot.
    static let dotSize: CGFloat = 10
    /// Space between the dot and the text.
    static let gap: CGFloat = 10
    /// Smallest distance the group keeps from the plate's left/right edge.
    static let padding: CGFloat = 10
    static let font = NSFont.monospacedDigitSystemFont(ofSize: 14, weight: .semibold)

    /// The label the panel draws, created here so the panel and the offline
    /// tests measure one identically configured control instead of drifting.
    static func makeLabel() -> NSTextField {
        let label = NSTextField(labelWithString: "")
        label.font = font
        label.alignment = .left
        label.lineBreakMode = .byClipping
        return label
    }

    /// The size the label really needs. Measuring the bare string under-reports
    /// by the cell's horizontal insets — 251.9 pt against the 256 pt the full
    /// recording line needs — which clipped the right edge of the final glyph.
    /// Ask the control itself instead.
    static func textSize(for label: NSTextField) -> CGSize {
        let size = label.fittingSize
        return CGSize(width: ceil(size.width), height: ceil(size.height))
    }

    /// Frames are returned in the same coordinate space as `hud`.
    ///
    /// A text wider than the plate can hold is clamped to the remaining space
    /// instead of overlapping the dot or leaving the plate; when the plate is
    /// too narrow even for the dot and the gap, the gap gives way first, so
    /// every frame still starts and ends inside the plate.
    static func frames(hud: CGRect,
                       text: CGSize,
                       dotSize: CGFloat = IndicatorLayout.dotSize,
                       gap: CGFloat = IndicatorLayout.gap,
                       padding: CGFloat = IndicatorLayout.padding) -> Frames {
        let available = max(0, hud.width - 2 * padding)
        let dotWidth = max(0, min(dotSize, available))
        let spacing = max(0, min(gap, available - dotWidth))
        let textWidth = max(0, min(text.width, available - dotWidth - spacing))
        let textHeight = max(0, text.height)
        let groupWidth = dotWidth + spacing + textWidth
        let groupMinX = hud.minX + (hud.width - groupWidth) / 2
        let midY = hud.midY

        return Frames(
            dot: CGRect(x: groupMinX, y: midY - dotWidth / 2, width: dotWidth, height: dotWidth),
            label: CGRect(x: groupMinX + dotWidth + spacing, y: midY - textHeight / 2,
                          width: textWidth, height: textHeight)
        )
    }
}

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
                     paused: false)
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

    /// `starting` is still accepted from the recorder but no longer changes the
    /// plate: a capture looks the same at 00:00 and at 00:05. Only the wording
    /// carries the state, and a pause dims the dot.
    func update(elapsed: Int, paused: Bool, starting: Bool) {
        panel?.update(text: IndicatorLabel.text(mode: indicatorLabelMode, elapsed: elapsed,
                                                paused: paused, starting: starting),
                      paused: paused)
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
    /// The one plate both modes use. Recording and replay differ only in the
    /// accent colour, never in the plate, so nothing changes mid-recording.
    private static let plateColor = NSColor(white: 0.08, alpha: 0.98)
    private let accent: NSColor
    private let mode: RecordingIndicator.Mode
    /// The glow reaches this far inside the screen edge. Static, gradient-only.
    private let glowWidth: CGFloat = 48
    private let hud: NSRect
    private let label = IndicatorLayout.makeLabel()
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
        badge.backgroundColor = Self.plateColor.cgColor
        dot.cornerRadius = IndicatorLayout.dotSize / 2
        dot.backgroundColor = accent.cgColor
        badge.addSublayer(dot)
        backing.addSublayer(badge)

        label.textColor = mode == .replay ? accent : .white
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.55)
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        label.shadow = shadow
        // The label is sized to its text and placed as half of one dot+text
        // group: the group is centred on the plate, not the text on what is
        // left of the plate after the dot.
        view.addSubview(label)
        layout()
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

    /// Sizes the label from the control's own fitting size and places the
    /// dot+text group in the plate. Only a wording change (running → paused)
    /// can move the group; the clock uses monospaced digits, so tick by tick
    /// the frames stay identical.
    private func layout() {
        let frames = IndicatorLayout.frames(
            hud: CGRect(origin: .zero, size: hud.size),
            text: IndicatorLayout.textSize(for: label))
        dot.frame = frames.dot
        dot.cornerRadius = frames.dot.width / 2
        label.frame = frames.label.offsetBy(dx: hud.minX, dy: hud.minY)
    }

    func update(text: String, paused: Bool) {
        if label.stringValue != text {
            label.stringValue = text
            layout()
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        // The plate is fixed for the whole session in both modes. A pause
        // dims the dot and the edge glow; it never repaints the plate.
        badge.backgroundColor = Self.plateColor.cgColor
        badge.borderWidth = 1
        badge.borderColor = accent.cgColor
        dot.opacity = paused ? 0.4 : 1
        for layer in glow { layer.opacity = mode == .replay ? 1 : (paused ? 0.35 : 1) }
        CATransaction.commit()
    }

    func covers(_ point: NSPoint) -> Bool {
        guard frame.contains(point) else { return false }
        let local = convertPoint(fromScreen: point)
        return hud.contains(local)
    }
}
