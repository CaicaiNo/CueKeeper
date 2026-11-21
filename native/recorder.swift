import AppKit
import Carbon
import CoreGraphics
import Foundation

// The listener is opt-in and never modifies or suppresses an input event.
@MainActor
final class Capture {
    private let app: String
    private let window: Int
    private let indicator: RecordingIndicator?
    private let sound: Bool
    private let ownPID = Int64(ProcessInfo.processInfo.processIdentifier)
    private var tap: CFMachPort?
    private var started: TimeInterval?
    private var pausedAt: TimeInterval?
    private var totalPaused: TimeInterval = 0
    private var targetWasFrontmost = false
    private var targetIsFrontmost = false
    private var secureInput = false
    private var events = 0
    private var stopped = false
    private(set) var failed = false

    init(app: String, window: Int, showIndicator: Bool, sound: Bool) {
        self.app = app
        self.window = window
        self.indicator = showIndicator ? RecordingIndicator() : nil
        self.sound = sound
    }

    func emit(_ object: [String: Any]) {
        do {
            var line = try JSONSerialization.data(withJSONObject: object)
            line.append(0x0A)
            try FileHandle.standardOutput.write(contentsOf: line)
        } catch {
            failed = true
            stop()
        }
    }

    func stop(_ code: String? = nil) {
        guard !stopped else { return }
        stopped = true
        if let code {
            failed = true
            emit(["kind": "error", "code": code])
        }
        guard let application = NSApp else { return }
        application.stop(nil)
        // Wake only the helper's own AppKit event queue.
        if let wake = NSEvent.otherEvent(with: .applicationDefined, location: .zero,
                                        modifierFlags: [], timestamp: 0, windowNumber: 0,
                                        context: nil, subtype: 0, data1: 0, data2: 0) {
            application.postEvent(wake, atStart: true)
        }
    }

    func start(tap: CFMachPort) {
        self.tap = tap
        started = ProcessInfo.processInfo.systemUptime
        rebuildIndicator()
        playCue()
        emit(["kind": "ready"])
        refreshFocus()
    }

    func closeIndicator() {
        indicator?.hide()
        if let cue = playCue() {
            RunLoop.current.run(until: Date().addingTimeInterval(min(cue.duration, 0.5)))
        }
    }

    @discardableResult
    private func playCue() -> NSSound? {
        guard sound, let cue = NSSound(named: NSSound.Name("Tink")) else { return nil }
        cue.play()
        return cue
    }

    func rebuildIndicator() {
        guard started != nil, !stopped else { return }
        indicator?.rebuild()
        updateIndicator()
    }

    private func updateIndicator() {
        guard let started else { return }
        let activeTime = (pausedAt ?? ProcessInfo.processInfo.systemUptime) - started - totalPaused
        indicator?.update(elapsed: Int(max(0, activeTime)), paused: pausedAt != nil)
    }

    @discardableResult
    func refreshFocus() -> NSRunningApplication? {
        guard started != nil, !stopped else { return nil }
        let frontmost = NSWorkspace.shared.frontmostApplication
        let target = frontmost?.bundleIdentifier == app ? frontmost : nil
        let active = target != nil
        guard active != targetIsFrontmost else { return target }
        targetIsFrontmost = active
        if targetWasFrontmost {
            emit(["kind": "focus", "active": active])
        }
        targetWasFrontmost = true
        secureInput = false
        return target
    }

    func checkSession() {
        guard !stopped, let tap else { return }
        guard CGPreflightListenEventAccess() else { stop("INPUT_MONITORING_LOST"); return }
        guard CFMachPortIsValid(tap) else { stop("TAP_UNAVAILABLE"); return }
        if !CGEvent.tapIsEnabled(tap: tap) {
            warn("TAP_INTERRUPTED")
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        refreshFocus()
        if targetIsFrontmost && pausedAt == nil { checkSecureInput() }
        updateIndicator()
    }

    @discardableResult
    private func checkSecureInput() -> Bool {
        let enabled = IsSecureEventInputEnabled()
        if enabled && !secureInput { warn("SECURE_INPUT") }
        secureInput = enabled
        return enabled
    }

    private func warn(_ code: String) {
        emit(["kind": "warning", "code": code])
    }

    private func togglePause() {
        let now = ProcessInfo.processInfo.systemUptime
        if let pausedAt {
            totalPaused += now - pausedAt
            self.pausedAt = nil
        } else {
            pausedAt = now
        }
        emit(["kind": "boundary"])
        updateIndicator()
    }

    func receive(_ type: CGEventType, _ event: CGEvent) {
        guard let started, !stopped else { return }
        // The session timer repairs a disabled tap while permission is still valid.
        guard type != .tapDisabledByTimeout && type != .tapDisabledByUserInput else { return }
        let hotkeyFlags = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let repeating = type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        if type == .keyDown && hotkeyFlags == [.maskControl, .maskAlternate] && (code == 7 || code == 35) {
            if !repeating {
                if code == 7 { stop() }  // Ctrl+Option+X
                else { togglePause() }   // Ctrl+Option+P
            }
            return
        }
        // Cmd+Tab (including reverse app cycling) belongs to the system app switcher.
        if type == .keyDown && code == 48 && hotkeyFlags.subtracting(.maskShift) == .maskCommand {
            emit(["kind": "boundary"])
            return
        }

        guard let frontmost = refreshFocus(), pausedAt == nil, !checkSecureInput() else { return }
        let destination = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard destination != ownPID, event.getIntegerValueField(.eventSourceUnixProcessID) != ownPID else { return }
        if type == .keyDown {
            guard destination <= 0 || destination == Int64(frontmost.processIdentifier) else { return }
        } else {
            guard let primary = NSScreen.screens.first else { return }
            let point = NSPoint(x: event.location.x, y: primary.frame.maxY - event.location.y)
            guard indicator?.covers(point) != true,
                  NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0) == window else {
                emit(["kind": "boundary"])
                return
            }
        }
        if repeating { warn("KEY_REPEAT"); return }
        events += 1
        if events == 1001 { warn("EVENT_LIMIT") }
        guard events <= 1000 else { return }
        let t = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
        let seen = Int(Date().timeIntervalSince1970 * 1000)
        if type == .leftMouseDown {
            let location = event.location
            guard hotkeyFlags.isEmpty && event.getIntegerValueField(.mouseEventClickState) == 1 else {
                warn("UNSUPPORTED_CLICK")
                return
            }
            emit(["kind": "click", "point": [Int(location.x.rounded()), Int(location.y.rounded())],
                  "t": t, "seen": seen])
            return
        }
        guard type == .keyDown else { warn("UNSUPPORTED_EVENT"); return }

        let flags: [(CGEventFlags, String)] = [
            (.maskCommand, "meta"), (.maskControl, "ctrl"), (.maskAlternate, "alt"), (.maskShift, "shift")
        ]
        let modifiers = flags.compactMap { flag, name in event.flags.contains(flag) ? name : nil }
        let special = namedKeys[code]
        if special == nil || special == "space" {
            if modifiers.isEmpty || modifiers == ["shift"] {
                var buffer = [UniChar](repeating: 0, count: 16)
                var length = 0
                event.keyboardGetUnicodeString(maxStringLength: buffer.count,
                                             actualStringLength: &length, unicodeString: &buffer)
                if length > 0 && length <= buffer.count {
                    let chars = String(decoding: buffer.prefix(length), as: UTF16.self)
                    if chars.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value <= 126 }) {
                        emit(["kind": "text", "chars": chars, "t": t, "seen": seen])
                        return
                    }
                }
                warn("UNSUPPORTED_TEXT")
                return
            }
        }
        guard let key = special ?? ansiKeys[code] else { warn("UNSUPPORTED_KEY"); return }
        emit(["kind": "key", "key": key, "modifiers": modifiers, "t": t, "seen": seen])
    }
}

// ANSI virtual key codes are used only for physical shortcut keys. Printable
// text comes from the event's Unicode payload and preserves capitalization.
let ansiKeys: [Int: String] = [
    0:"a", 1:"s", 2:"d", 3:"f", 4:"h", 5:"g", 6:"z", 7:"x", 8:"c", 9:"v",
    11:"b", 12:"q", 13:"w", 14:"e", 15:"r", 16:"y", 17:"t", 18:"1", 19:"2",
    20:"3", 21:"4", 22:"6", 23:"5", 25:"9", 26:"7", 28:"8", 29:"0", 31:"o",
    32:"u", 34:"i", 35:"p", 37:"l", 38:"j", 40:"k", 45:"n", 46:"m"
]
let namedKeys: [Int: String] = [
    36:"return", 48:"tab", 49:"space", 51:"backspace", 53:"escape",
    96:"f5", 97:"f6", 98:"f7", 99:"f3", 100:"f8", 101:"f9", 103:"f11", 109:"f10",
    111:"f12", 115:"home", 116:"pageup", 117:"forwarddelete", 118:"f4", 119:"end",
    120:"f2", 121:"pagedown", 122:"f1", 123:"left", 124:"right", 125:"down", 126:"up"
]

@main
struct RecorderCommand {
    @MainActor
    static func main() {
        let args = CommandLine.arguments
        let switches = args.dropFirst(4)
        guard args.count >= 4, let window = Int(args[2]), window > 0,
              let seconds = Double(args[3]), (1...60).contains(seconds),
              switches.allSatisfy({ $0 == "--no-indicator" || $0 == "--sound" }) else {
            exit(2)
        }
        let capture = Capture(app: args[1], window: window,
                              showIndicator: !switches.contains("--no-indicator"),
                              sound: switches.contains("--sound"))
        guard CGPreflightListenEventAccess() else {
            capture.emit(["kind": "error", "code": "INPUT_MONITORING_REQUIRED"])
            exit(2)
        }
        let observedTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown,
                                            .leftMouseDragged, .keyDown, .scrollWheel]
        let mask = observedTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context = Unmanaged.passUnretained(capture).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
            eventsOfInterest: mask, callback: { _, type, event, context in
                if let context {
                    MainActor.assumeIsolated {
                        Unmanaged<Capture>.fromOpaque(context).takeUnretainedValue().receive(type, event)
                    }
                }
                return Unmanaged.passUnretained(event)
            }, userInfo: context
        ), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            capture.emit(["kind": "error", "code": "TAP_UNAVAILABLE"])
            exit(2)
        }
        CGEvent.tapEnable(tap: tap, enable: false)
        let application = NSApplication.shared
        application.setActivationPolicy(.accessory)
        let loop = CFRunLoopGetMain()
        let workspace = NSWorkspace.shared.notificationCenter
        let screens = NotificationCenter.default
        let focusObserver = workspace.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                  object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { _ = capture.refreshFocus() }
        }
        let screenObserver = screens.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                  object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { capture.rebuildIndicator() }
        }
        let tick = Timer(timeInterval: 0.25, repeats: true) { _ in
            MainActor.assumeIsolated { capture.checkSession() }
        }
        let deadline = Timer(timeInterval: seconds, repeats: false) { _ in
            MainActor.assumeIsolated { capture.stop() }
        }
        DispatchQueue.main.async {
            capture.start(tap: tap)
            CFRunLoopAddSource(loop, source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            RunLoop.main.add(tick, forMode: .common)
            deadline.fireDate = Date().addingTimeInterval(seconds)
            RunLoop.main.add(deadline, forMode: .common)
        }
        application.run()
        tick.invalidate()
        deadline.invalidate()
        workspace.removeObserver(focusObserver)
        screens.removeObserver(screenObserver)
        CGEvent.tapEnable(tap: tap, enable: false)
        CFRunLoopRemoveSource(loop, source, .commonModes)
        CFMachPortInvalidate(tap)
        capture.closeIndicator()
        exit(capture.failed ? 1 : 0)
    }
}
