import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

// Recording observes input downstream of a separate filter for its two session controls.
@MainActor
final class Capture {
    private let app: String
    private let window: Int
    private let indicator: RecordingIndicator?
    private let sound: Bool
    private let traceClicks: Bool
    private let ownPID = Int64(ProcessInfo.processInfo.processIdentifier)
    private var tap: CFMachPort?
    private var hotkeyTap: CFMachPort?
    private var hotkeys = RecordingHotkeys()
    private var stopReleaseDeadline: TimeInterval?
    private var pauseBoundaryPending = false
    private var seconds: TimeInterval = 0
    private var readyNotBefore: TimeInterval = 0
    private var indicatorDeadline: TimeInterval = 0
    private var recordingDeadline: Timer?
    private var started: TimeInterval?
    private var pausedAt: TimeInterval?
    private var totalPaused: TimeInterval = 0
    private var targetWasFrontmost = false
    private var targetIsFrontmost = false
    private var secureInput = false
    private var events = 0
    private var stopped = false
    private(set) var failed = false

    init(app: String, window: Int, showIndicator: Bool, sound: Bool, traceClicks: Bool) {
        self.app = app
        self.window = window
        self.indicator = showIndicator ? RecordingIndicator() : nil
        self.sound = sound
        self.traceClicks = traceClicks
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

    func stop(_ code: String? = nil, detail: String? = nil) {
        guard !stopped else { return }
        stopped = true
        recordingDeadline?.invalidate()
        traceMouseLifecycle("stopped", code: code)
        if let code {
            failed = true
            var error = ["kind": "error", "code": code]
            error["detail"] = detail
            emit(error)
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

    func prepare(tap: CFMachPort, hotkeyTap: CFMachPort, seconds: TimeInterval) {
        self.tap = tap
        self.hotkeyTap = hotkeyTap
        self.seconds = seconds
        if let indicator {
            if let detail = indicator.show() {
                stop("INDICATOR_NOT_VISIBLE", detail: detail)
                return
            }
        }
        // Both run-loop sources are installed before prepare. Let the taps settle
        // while the HUD still says it is preparing, then check both before READY.
        CGEvent.tapEnable(tap: hotkeyTap, enable: true)
        CGEvent.tapEnable(tap: tap, enable: true)
        let now = ProcessInfo.processInfo.systemUptime
        readyNotBefore = now + 0.35
        indicatorDeadline = now + 2
        traceMouseLifecycle("tap_enable_requested")
    }

    private func begin(indicatorEvidence: Any) {
        guard !stopped, let tap, let hotkeyTap else { return }
        guard CFMachPortIsValid(hotkeyTap), CGEvent.tapIsEnabled(tap: hotkeyTap) else {
            stop("HOTKEY_TAP_UNAVAILABLE", detail: "The recording hotkey filter did not enable")
            return
        }
        guard CFMachPortIsValid(tap), CGEvent.tapIsEnabled(tap: tap) else {
            stop("TAP_UNAVAILABLE", detail: "The input event tap did not enable")
            return
        }
        started = ProcessInfo.processInfo.systemUptime
        let deadline = Timer(timeInterval: seconds, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.stopReleaseDeadline == nil else { return }
                self.stop()
            }
        }
        recordingDeadline = deadline
        RunLoop.main.add(deadline, forMode: .common)
        updateIndicator()
        playCue()
        traceMouseLifecycle("ready")
        emit(["kind": "ready", "indicator": indicatorEvidence, "hotkeysFiltered": true])
        refreshFocus()
    }

    func closeIndicator() {
        indicator?.hide()
        if started != nil, let cue = playCue() {
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
        guard tap != nil, !stopped else { return }
        if let detail = indicator?.show() {
            stop("INDICATOR_NOT_VISIBLE", detail: detail)
            return
        }
        updateIndicator()
    }

    private func updateIndicator() {
        guard let started else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let activeTime = (pausedAt ?? now) - started - totalPaused
        indicator?.update(elapsed: Int(max(0, activeTime)), paused: pausedAt != nil,
                          starting: pausedAt == nil && now - started < 3)
    }

    @discardableResult
    func refreshFocus() -> NSRunningApplication? {
        guard started != nil, !stopped, stopReleaseDeadline == nil else { return nil }
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
        guard !stopped, let tap, let hotkeyTap else { return }
        if started == nil {
            let now = ProcessInfo.processInfo.systemUptime
            guard now >= readyNotBefore else { return }
            guard let indicator else {
                begin(indicatorEvidence: false)
                return
            }
            switch indicator.visibility() {
            case .confirmed(let evidence): begin(indicatorEvidence: evidence)
            case .waiting(let detail):
                if now >= indicatorDeadline {
                    stop("INDICATOR_NOT_VISIBLE", detail: detail)
                }
            }
            return
        }
        if let deadline = stopReleaseDeadline, ProcessInfo.processInfo.systemUptime >= deadline {
            stop()
            return
        }
        guard CGPreflightListenEventAccess() else { stop("INPUT_MONITORING_LOST"); return }
        guard AXIsProcessTrusted() else { stop("ACCESSIBILITY_LOST"); return }
        guard CFMachPortIsValid(hotkeyTap), CGEvent.tapIsEnabled(tap: hotkeyTap) else {
            stop("HOTKEY_TAP_UNAVAILABLE", detail: "The recording hotkey filter became unavailable")
            return
        }
        guard CFMachPortIsValid(tap) else { stop("TAP_UNAVAILABLE"); return }
        if !CGEvent.tapIsEnabled(tap: tap) {
            traceMouseLifecycle("tap_interrupted")
            warn("TAP_INTERRUPTED")
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        flushPauseBoundary()
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
        pauseBoundaryPending = true
    }

    private func flushPauseBoundary() {
        guard pauseBoundaryPending else { return }
        pauseBoundaryPending = false
        emit(["kind": "boundary"])
    }

    func consumeHotkey(_ type: CGEventType, _ event: CGEvent) -> Bool {
        guard started != nil, !stopped, type == .keyDown || type == .keyUp else { return false }
        let flags = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        let action = hotkeys.route(
            code: Int(event.getIntegerValueField(.keyboardEventKeycode)),
            down: type == .keyDown, matchesChord: flags == [.maskControl, .maskAlternate],
            repeating: event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        )
        switch action {
        case .togglePause:
            if stopReleaseDeadline == nil { togglePause() }
        case .requestStop:
            // Stop accepting actions immediately. Keep filtering until key-up, with a bounded fallback.
            if stopReleaseDeadline == nil { stopReleaseDeadline = ProcessInfo.processInfo.systemUptime + 0.75 }
        case .releaseStop:
            stopReleaseDeadline = ProcessInfo.processInfo.systemUptime
        case .forward, .consume:
            break
        }
        return action.consumesEvent
    }

    func receive(_ type: CGEventType, _ event: CGEvent) {
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            receivePointer(type, event, down: true)
            return
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            receivePointer(type, event, down: false)
            return
        default:
            break
        }
        guard let started, !stopped, stopReleaseDeadline == nil else { return }
        // The session timer repairs a disabled tap while permission is still valid.
        guard type != .tapDisabledByTimeout && type != .tapDisabledByUserInput else { return }
        flushPauseBoundary()
        let hotkeyFlags = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let repeating = type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        // Cmd+Tab (including reverse app cycling) belongs to the system app switcher.
        if type == .keyDown && code == 48 && hotkeyFlags.subtracting(.maskShift) == .maskCommand {
            emit(["kind": "boundary"])
            return
        }

        guard pausedAt == nil else { return }
        let destination = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard destination != ownPID, event.getIntegerValueField(.eventSourceUnixProcessID) != ownPID else { return }
        if type == .keyDown {
            guard let frontmost = refreshFocus(), !checkSecureInput(),
                  destination <= 0 || destination == Int64(frontmost.processIdentifier) else { return }
        } else {
            // The mouse down may be the event that makes this window frontmost.
            guard let primary = NSScreen.screens.first else { return }
            let point = NSPoint(x: event.location.x, y: primary.frame.maxY - event.location.y)
            guard indicator?.covers(point) != true,
                  NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0) == window else {
                emit(["kind": "boundary"])
                return
            }
        }
        if repeating { warn("KEY_REPEAT"); return }
        guard registerEvent() else { return }
        let t = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
        let seen = Int(Date().timeIntervalSince1970 * 1000)
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

    private func registerEvent() -> Bool {
        if events < 1001 {
            events += 1
            if events == 1001 { warn("EVENT_LIMIT") }
        }
        return events <= 1000
    }

    private func traceMouseLifecycle(_ event: String, code: String? = nil) {
        guard traceClicks else { return }
        var row: [String: Any] = ["kind": "click_trace", "stage": "native", "event": event,
                                  "targetWindow": window, "seenAtMs": Int(Date().timeIntervalSince1970 * 1000),
                                  "observedUptimeNs": String(DispatchTime.now().uptimeNanoseconds)]
        row["code"] = code
        emit(row)
    }

    private func receivePointer(_ type: CGEventType, _ event: CGEvent, down: Bool) {
        let phase: PointerObservation.Phase
        if stopped || stopReleaseDeadline != nil { phase = .stopping }
        else if started == nil { phase = .preparing }
        else if pausedAt != nil { phase = .paused }
        else { phase = .recording }
        guard traceClicks || (phase == .recording && down) else { return }
        let seen = Int(Date().timeIntervalSince1970 * 1000)
        if phase == .recording { flushPauseBoundary() }

        let location = event.location
        let screenPoint = NSScreen.screens.first.map { NSPoint(x: location.x, y: $0.frame.maxY - location.y) }
        let hit = screenPoint.map { NSWindow.windowNumber(at: $0, belowWindowWithWindowNumber: 0) }
        let frontmost = traceClicks ? NSWorkspace.shared.frontmostApplication : nil
        let targetAppFrontmost = frontmost.map { $0.bundleIdentifier == app }
        // The top normal window is a diagnostic hint for activation within the same app.
        var frontWindow: Int?
        if hit == window, let frontmost, targetAppFrontmost == true,
           let info = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
            let top = info.first {
                ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == frontmost.processIdentifier &&
                ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
            }
            frontWindow = (top?[kCGWindowNumber as String] as? NSNumber)?.intValue
        }
        let clickCount = event.getIntegerValueField(.mouseEventClickState)
        let modifiers = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        let observation = PointerObservation(
            phase: phase, down: down,
            plainLeftClick: type == .leftMouseDown && clickCount == 1 && modifiers.isEmpty,
            recorderEvent: event.getIntegerValueField(.eventTargetUnixProcessID) == ownPID ||
                event.getIntegerValueField(.eventSourceUnixProcessID) == ownPID,
            overIndicator: screenPoint.map { indicator?.covers($0) == true } ?? false,
            hitWindow: hit.flatMap { $0 > 0 ? $0 : nil }, targetWindow: window,
            targetAppFrontmost: targetAppFrontmost, frontWindow: frontWindow, atLimit: events >= 1000
        )
        let eventNumber = event.getIntegerValueField(.mouseEventNumber)
        let traceId = "\(event.timestamp):\(eventNumber)"
        if traceClicks {
            emit(observation.trace(id: traceId, timestampNs: String(event.timestamp), seenAtMs: seen,
                                   point: [Double(location.x), Double(location.y)], eventNumber: eventNumber,
                                   button: event.getIntegerValueField(.mouseEventButtonNumber), clickCount: clickCount,
                                   modifierFlags: modifiers.rawValue,
                                   quartzWindow: event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)))
        }
        guard !stopped else { return }
        switch observation.reason {
        case .accepted:
            guard let started, registerEvent() else { return }
            var click: [String: Any] = [
                "kind": "click", "point": [Int(location.x.rounded()), Int(location.y.rounded())],
                "t": Int((ProcessInfo.processInfo.systemUptime - started) * 1000), "seen": seen,
            ]
            if traceClicks { click["traceId"] = traceId }
            emit(click)
        case .unsupportedClick:
            if registerEvent() { warn(type == .leftMouseDown ? "UNSUPPORTED_CLICK" : "UNSUPPORTED_EVENT") }
        case .eventLimit:
            _ = registerEvent()
        case .overlay, .otherWindow, .noWindow:
            if down { emit(["kind": "boundary"]) }
        case .beforeReady, .paused, .stopping, .mouseUp, .recorderEvent:
            break
        }
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
              let seconds = Double(args[3]), (1...90).contains(seconds),
              switches.allSatisfy({ $0 == "--no-indicator" || $0 == "--sound" || $0 == "--trace-clicks" }) else {
            exit(2)
        }
        let capture = Capture(app: args[1], window: window,
                              showIndicator: !switches.contains("--no-indicator"),
                              sound: switches.contains("--sound"),
                              traceClicks: switches.contains("--trace-clicks"))
        guard CGPreflightListenEventAccess() else {
            capture.emit(["kind": "error", "code": "INPUT_MONITORING_REQUIRED"])
            exit(2)
        }
        guard AXIsProcessTrusted() else {
            capture.emit(["kind": "error", "code": "ACCESSIBILITY_REQUIRED",
                          "detail": "Recording hotkeys require Accessibility access for this helper"])
            exit(2)
        }
        var observedTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown,
                                            .leftMouseDragged, .keyDown, .scrollWheel]
        if switches.contains("--trace-clicks") { observedTypes += [.leftMouseUp, .rightMouseUp, .otherMouseUp] }
        let mask = observedTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let context = Unmanaged.passUnretained(capture).toOpaque()
        let hotkeyMask = (CGEventMask(1) << CGEventType.keyDown.rawValue) |
                         (CGEventMask(1) << CGEventType.keyUp.rawValue)
        guard let hotkeyTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: hotkeyMask, callback: { _, type, event, context in
                guard let context else { return Unmanaged.passUnretained(event) }
                let consumed = MainActor.assumeIsolated {
                    Unmanaged<Capture>.fromOpaque(context).takeUnretainedValue().consumeHotkey(type, event)
                }
                return consumed ? nil : Unmanaged.passUnretained(event)
            }, userInfo: context
        ), let hotkeySource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, hotkeyTap, 0) else {
            capture.emit(["kind": "error", "code": "HOTKEY_TAP_UNAVAILABLE",
                          "detail": "Could not create the recording hotkey filter"])
            exit(2)
        }
        CGEvent.tapEnable(tap: hotkeyTap, enable: false)
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
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
            CFMachPortInvalidate(hotkeyTap)
            exit(2)
        }
        CGEvent.tapEnable(tap: tap, enable: false)
        let application = NSApplication.shared
        guard application.setActivationPolicy(.accessory) else {
            capture.emit(["kind": "error", "code": "CAPTURE_APPKIT_SETUP", "detail": "Could not set accessory activation policy"])
            CFMachPortInvalidate(tap)
            CFMachPortInvalidate(hotkeyTap)
            exit(2)
        }
        NSWindow.allowsAutomaticWindowTabbing = false
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
        DispatchQueue.main.async {
            CFRunLoopAddSource(loop, hotkeySource, .commonModes)
            CFRunLoopAddSource(loop, source, .commonModes)
            capture.prepare(tap: tap, hotkeyTap: hotkeyTap, seconds: seconds)
            RunLoop.main.add(tick, forMode: .common)
        }
        application.run()
        tick.invalidate()
        workspace.removeObserver(focusObserver)
        screens.removeObserver(screenObserver)
        CGEvent.tapEnable(tap: tap, enable: false)
        CGEvent.tapEnable(tap: hotkeyTap, enable: false)
        CFRunLoopRemoveSource(loop, source, .commonModes)
        CFRunLoopRemoveSource(loop, hotkeySource, .commonModes)
        CFMachPortInvalidate(tap)
        CFMachPortInvalidate(hotkeyTap)
        capture.closeIndicator()
        exit(capture.failed ? 1 : 0)
    }
}
