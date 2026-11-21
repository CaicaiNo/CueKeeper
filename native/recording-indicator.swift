import AppKit
import QuartzCore

@MainActor
final class RecordingIndicator {
    private var overlays: [IndicatorPanel] = []

    func rebuild() {
        hide()
        overlays = NSScreen.screens.map(IndicatorPanel.init)
        for panel in overlays { panel.orderFrontRegardless() }
    }

    func update(elapsed: Int, paused: Bool) {
        let time = String(format: "%02d:%02d", elapsed / 60, elapsed % 60)
        let state = paused ? "已暂停" : "录制中"
        let action = paused ? "继续" : "暂停"
        for panel in overlays {
            panel.update(text: "\(state)  \(time)     ⌃⌥P \(action)   ⌃⌥X 停止", paused: paused)
        }
    }

    func covers(_ point: NSPoint) -> Bool {
        overlays.contains { $0.covers(point) }
    }

    func hide() {
        for panel in overlays { panel.orderOut(nil) }
        overlays.removeAll()
    }
}

@MainActor
private final class IndicatorPanel: NSPanel {
    private static let accent = NSColor(srgbRed: 1, green: 0.31, blue: 0.37, alpha: 1)
    private let borderWidth: CGFloat
    private let hud: NSRect
    private let label = NSTextField(labelWithString: "")
    private let dot = CALayer()
    private let highlight = CAShapeLayer()

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    init(screen: NSScreen) {
        let frame = screen.frame
        let size = frame.size
        borderWidth = 3 / screen.backingScaleFactor
        let hudWidth = min(308, size.width - 20)
        hud = NSRect(x: (size.width - hudWidth) / 2, y: screen.visibleFrame.maxY - frame.minY - 44,
                     width: hudWidth, height: 34)
        super.init(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        hidesOnDeactivate = false
        ignoresMouseEvents = true
        sharingType = .none
        level = .statusBar
        collectionBehavior = [.canJoinAllSpaces, .ignoresCycle, .stationary]
        if #available(macOS 13.0, *) {
            collectionBehavior.insert(.canJoinAllApplications)
        } else {
            collectionBehavior.insert(.fullScreenAuxiliary)
        }
        setFrame(frame, display: false)

        let view = NSView(frame: NSRect(origin: .zero, size: size))
        view.wantsLayer = true
        contentView = view

        let path = CGPath(rect: view.bounds.insetBy(dx: borderWidth / 2, dy: borderWidth / 2), transform: nil)
        let border = CAShapeLayer()
        for layer in [border, highlight] {
            layer.frame = view.bounds
            layer.path = path
            layer.fillColor = nil
            layer.lineWidth = borderWidth
            view.layer?.addSublayer(layer)
        }
        border.strokeColor = Self.accent.withAlphaComponent(0.6).cgColor
        highlight.strokeColor = Self.accent.cgColor
        let perimeter = 2 * (size.width + size.height - 2 * borderWidth)
        let segment = min(160, perimeter / 12)
        highlight.lineDashPattern = [NSNumber(value: Double(segment)), NSNumber(value: Double(perimeter - segment))]
        let sweep = CABasicAnimation(keyPath: "lineDashPhase")
        sweep.fromValue = 0
        sweep.toValue = -perimeter
        sweep.duration = 7
        sweep.repeatCount = .infinity
        highlight.add(sweep, forKey: "sweep")

        let badge = CALayer()
        badge.frame = hud
        badge.cornerRadius = 12
        badge.backgroundColor = NSColor(white: 0.08, alpha: 0.95).cgColor
        dot.frame = CGRect(x: 14, y: 13, width: 8, height: 8)
        dot.cornerRadius = 4
        dot.backgroundColor = Self.accent.cgColor
        badge.addSublayer(dot)
        view.layer?.addSublayer(badge)

        label.frame = hud.insetBy(dx: 16, dy: 9).offsetBy(dx: 7, dy: 0)
        label.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        label.textColor = .white
        label.alignment = .center
        view.addSubview(label)
    }

    func update(text: String, paused: Bool) {
        if label.stringValue != text { label.stringValue = text }
        dot.opacity = paused ? 0.4 : 1
        highlight.isHidden = paused
    }

    func covers(_ point: NSPoint) -> Bool {
        guard frame.contains(point) else { return false }
        let local = convertPoint(fromScreen: point)
        let interior = NSRect(origin: .zero, size: frame.size).insetBy(dx: borderWidth, dy: borderWidth)
        return hud.contains(local) || !interior.contains(local)
    }
}
