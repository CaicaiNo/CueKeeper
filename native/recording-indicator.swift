import AppKit
import CoreGraphics
import QuartzCore

@MainActor
final class RecordingIndicator {
    enum Visibility {
        case waiting(String)
        case confirmed([String: Any])
    }

    private var panel: IndicatorPanel?
    private var displayID = CGMainDisplayID()

    func show() -> String? {
        hide()
        displayID = CGMainDisplayID()
        let key = NSDeviceDescriptionKey("NSScreenNumber")
        guard let screen = NSScreen.screens.first(where: {
            ($0.deviceDescription[key] as? NSNumber)?.uint32Value == displayID
        }) else { return "Primary display is unavailable to AppKit" }
        guard let panel = IndicatorPanel(screen: screen) else { return "AppKit did not create the indicator backing layer" }
        self.panel = panel
        panel.update(text: "正在准备录制", paused: false, starting: false)
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
        let time = String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
        let state = paused ? "已暂停" : starting ? "录制就绪" : "录制中"
        let action = paused ? "继续" : "暂停"
        panel?.update(text: "\(state)  \(time)     ⌃⌥P \(action)   ⌃⌥X 停止", paused: paused, starting: starting)
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
    private static let accent = NSColor(srgbRed: 1, green: 0.24, blue: 0.34, alpha: 1)
    private let borderWidth: CGFloat = 3
    private let edgeInset: CGFloat = 2
    private let hud: NSRect
    private let label = NSTextField(labelWithString: "")
    private let border = CAShapeLayer()
    private let badge = CALayer()
    private let dot = CALayer()
    private let highlight = CAShapeLayer()

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init?(screen: NSScreen) {
        let frame = screen.frame
        let size = frame.size
        let hudWidth = min(360, size.width - 20)
        hud = NSRect(x: (size.width - hudWidth) / 2, y: screen.visibleFrame.maxY - frame.minY - 58,
                     width: hudWidth, height: 46)
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        sharingType = .none
        level = .statusBar
        collectionBehavior = [.ignoresCycle]
        setFrame(frame, display: false)

        let view = NSView(frame: NSRect(origin: .zero, size: size))
        contentView = view
        view.wantsLayer = true
        guard let backing = view.layer else { return nil }

        let strokeInset = edgeInset + borderWidth / 2
        let path = CGPath(rect: view.bounds.insetBy(dx: strokeInset, dy: strokeInset), transform: nil)
        for layer in [border, highlight] {
            layer.frame = view.bounds
            layer.path = path
            layer.fillColor = nil
            layer.lineWidth = borderWidth
            backing.addSublayer(layer)
        }
        highlight.strokeColor = Self.accent.cgColor
        let perimeter = 2 * (size.width + size.height - 4 * strokeInset)
        let segment = min(160, perimeter / 12)
        highlight.lineDashPattern = [NSNumber(value: Double(segment)), NSNumber(value: Double(perimeter - segment))]
        let sweep = CABasicAnimation(keyPath: "lineDashPhase")
        sweep.fromValue = 0
        sweep.toValue = -perimeter
        sweep.duration = 7
        sweep.repeatCount = .infinity
        highlight.add(sweep, forKey: "sweep")

        badge.frame = hud
        badge.cornerRadius = 14
        badge.borderWidth = 1
        badge.borderColor = Self.accent.cgColor
        dot.frame = CGRect(x: 16, y: 18, width: 10, height: 10)
        dot.cornerRadius = 5
        dot.backgroundColor = Self.accent.cgColor
        badge.addSublayer(dot)
        backing.addSublayer(badge)

        label.frame = NSRect(x: hud.minX + 32, y: hud.midY - 9, width: hud.width - 48, height: 20)
        label.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        label.textColor = .white
        label.alignment = .center
        view.addSubview(label)
    }

    func update(text: String, paused: Bool, starting: Bool) {
        if label.stringValue != text { label.stringValue = text }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        badge.backgroundColor = starting
            ? NSColor(srgbRed: 0.40, green: 0.055, blue: 0.105, alpha: 1).cgColor
            : NSColor(white: 0.08, alpha: 0.98).cgColor
        badge.borderWidth = starting ? 2 : 1
        border.strokeColor = Self.accent.withAlphaComponent(starting ? 1 : 0.86).cgColor
        dot.opacity = paused ? 0.4 : 1
        highlight.isHidden = paused
        CATransaction.commit()
    }

    func covers(_ point: NSPoint) -> Bool {
        guard frame.contains(point) else { return false }
        let local = convertPoint(fromScreen: point)
        let bounds = NSRect(origin: .zero, size: frame.size)
        let outsideStroke = bounds.insetBy(dx: edgeInset, dy: edgeInset)
        let strokeInnerEdge = edgeInset + borderWidth
        let insideStroke = bounds.insetBy(dx: strokeInnerEdge, dy: strokeInnerEdge)
        return hud.contains(local) || (outsideStroke.contains(local) && !insideStroke.contains(local))
    }
}
