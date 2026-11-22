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
    private let pid: Int32?
    private let bundlePath: String?
    private let global: Bool
    private let exclude: Set<String>
    private let indicator: RecordingIndicator?
    private let sound: Bool
    private let traceClicks: Bool
    private let ownPID = Int64(ProcessInfo.processInfo.processIdentifier)
    private var tap: CFMachPort?
    private var hotkeyTap: CFMachPort?
    private var hotkeys = RecordingHotkeys()
    private var pointer = RecordingPointer()
    private var hover = HoverTracker()
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

    // Global attribution evidence. The generation advances whenever the front
    // app or its focused window changes, so a late notification can only
    // confirm evidence, never move the recording back to a window it left.
    private var focusGeneration = 0
    private var focusPid: Int32?
    private var focusApp: String?
    private var focusInstance: Int?
    private var focusWindowNumber: Int?
    private var focusTitle: String?
    // The pointer evidence frozen on mouse-down; release uses it unchanged.
    private var pendingPointEvidence: [String: Any]?
    private var lagNotedAt: TimeInterval = 0

    private var eventLimit: Int { global ? 20_000 : 1000 }

    init(app: String, window: Int, pid: Int32?, bundlePath: String?, global: Bool = false,
         exclude: Set<String> = [], showIndicator: Bool, sound: Bool, traceClicks: Bool) {
        self.app = app
        self.window = window
        self.pid = pid
        self.bundlePath = bundlePath
        self.global = global
        self.exclude = exclude
        self.indicator = showIndicator ? RecordingIndicator() : nil
        self.sound = sound
        self.traceClicks = traceClicks
    }

    /** Owner PID of the selected native window, read without focusing it. */
    private func windowOwnerPid() -> Int32? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(window)) as? [[String: Any]],
              let owner = list.first?[kCGWindowOwnerPID as String] as? NSNumber else { return nil }
        return owner.int32Value
    }

    // MARK: - Global attribution evidence

    private struct FocusedWindow {
        let number: Int?
        let title: String
    }

    private func axAttribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private func axString(_ element: AXUIElement, _ name: String) -> String? {
        axAttribute(element, name) as? String
    }

    private func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = axAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        return (value as! AXUIElement)
    }

    private func axPoint(_ element: AXUIElement, _ name: String) -> CGPoint? {
        guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        var point = CGPoint.zero
        guard AXValueGetValue(value as! AXValue, .cgPoint, &point) else { return nil }
        return point
    }

    private func axSize(_ element: AXUIElement, _ name: String) -> CGSize? {
        guard let value = axAttribute(element, name), CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        var size = CGSize.zero
        guard AXValueGetValue(value as! AXValue, .cgSize, &size) else { return nil }
        return size
    }

    private func axActions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success,
              let names = names as? [String] else { return [] }
        return names
    }

    private func launchMillis(_ application: NSRunningApplication) -> Int? {
        application.launchDate.map { Int($0.timeIntervalSince1970 * 1000) }
    }

    /**
     * Resolves the focused window's native number without a private AX call.
     * The AX focused window is matched to the app's layer-0 CGWindow by frame;
     * a single-window app is accepted without a frame match.
     */
    private func focusedWindowInfo(_ application: NSRunningApplication) -> FocusedWindow? {
        let axApp = AXUIElementCreateApplication(application.processIdentifier)
        guard let axWindow = axElement(axApp, kAXFocusedWindowAttribute as String) else { return nil }
        let title = axString(axWindow, kAXTitleAttribute as String) ?? ""
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                   kCGNullWindowID) as? [[String: Any]] else {
            return FocusedWindow(number: nil, title: title)
        }
        let owned = list.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == application.processIdentifier &&
            ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
        }
        if let position = axPoint(axWindow, kAXPositionAttribute as String),
           let size = axSize(axWindow, kAXSizeAttribute as String) {
            for entry in owned {
                guard let bounds = entry[kCGWindowBounds as String] as? NSDictionary,
                      let rect = CGRect(dictionaryRepresentation: bounds),
                      abs(rect.minX - position.x) <= 4, abs(rect.minY - position.y) <= 4,
                      abs(rect.width - size.width) <= 8, abs(rect.height - size.height) <= 8,
                      let number = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
                return FocusedWindow(number: number, title: title)
            }
        }
        if owned.count == 1,
           let number = (owned[0][kCGWindowNumber as String] as? NSNumber)?.intValue {
            return FocusedWindow(number: number, title: title)
        }
        return FocusedWindow(number: nil, title: title)
    }

    /** Advances the evidence generation when the front app or window changes. */
    private func noteFocus(pid: Int32?, app: String?, window: Int?, title: String?, instance: Int?, report: Bool) {
        let changed = pid != focusPid || app != focusApp || window != focusWindowNumber
        if !changed {
            if let title, title != focusTitle {
                focusTitle = title
            }
            return
        }
        focusGeneration += 1
        focusPid = pid
        focusApp = app
        focusWindowNumber = window
        focusTitle = title
        focusInstance = instance
        guard report, let pid, let app else { return }
        var owner: [String: Any] = ["app": app, "pid": Int(pid)]
        if let instance { owner["processInstance"] = instance }
        if let window { owner["windowNumber"] = window }
        if let title { owner["windowTitle"] = title }
        emit([
            "kind": "focus", "t": elapsedMs(), "seen": wallClockMs(),
            "focusGeneration": focusGeneration, "secure": IsSecureEventInputEnabled(),
            "owner": owner,
        ])
    }

    @discardableResult
    private func refreshGlobalFocus() -> NSRunningApplication? {
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return nil }
        targetIsFrontmost = true
        targetWasFrontmost = true
        let instance = launchMillis(frontmost)
        guard frontmost.processIdentifier != Int32(ownPID) else { return nil }
        guard let app = frontmost.bundleIdentifier, !exclude.contains(app) else {
            noteFocus(pid: frontmost.processIdentifier, app: nil, window: nil, title: nil,
                      instance: instance, report: false)
            return nil
        }
        let window = focusedWindowInfo(frontmost)
        // Focus changes while paused update evidence but never become steps.
        noteFocus(pid: frontmost.processIdentifier, app: app, window: window?.number,
                  title: window?.title, instance: instance,
                  report: pausedAt == nil && stopReleaseDeadline == nil)
        return frontmost
    }

    private func wallClockMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    private func elapsedMs() -> Int {
        guard let started else { return 0 }
        return Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
    }

    private func excluded(_ app: String?) -> Bool {
        guard let app else { return false }
        return exclude.contains(app)
    }

    /**
     * What AX and the native window stack can prove about the window under a
     * pointer. A missing or conflicting owner is reported as a gap; the
     * TypeScript engine never fills it in from another window's snapshot.
     */
    private func pointerEvidence(screenPoint: NSPoint, activation: Bool) -> [String: Any] {
        let quartzX = Float(screenPoint.x)
        let quartzY = Float(NSScreen.screens.first.map { $0.frame.maxY - screenPoint.y } ?? screenPoint.y)
        let stackWindow = NSWindow.windowNumber(at: screenPoint, belowWindowWithWindowNumber: 0)
        var stackPid: Int32?
        var stackApp: String?
        var stackTitle = ""
        var stackInstance: Int?
        if stackWindow > 0,
           let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(stackWindow)) as? [[String: Any]],
           let info = list.first {
            stackPid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            stackTitle = (info[kCGWindowName as String] as? String) ?? ""
            if let stackPid {
                let owner = NSRunningApplication(processIdentifier: stackPid)
                stackApp = owner?.bundleIdentifier
                stackInstance = owner.flatMap { launchMillis($0) }
            }
        }
        var axPid: Int32?
        var role: String?
        var subrole: String?
        var name: String?
        var windowTitle = stackTitle
        var pressable = false
        // Never read AX for an excluded app: exclusion is a privacy boundary.
        if !excluded(stackApp) {
            let system = AXUIElementCreateSystemWide()
            var hit: AXUIElement?
            if AXUIElementCopyElementAtPosition(system, quartzX, quartzY, &hit) == .success, let hit {
                var elementPid: pid_t = 0
                AXUIElementGetPid(hit, &elementPid)
                axPid = elementPid
                role = axString(hit, kAXRoleAttribute as String)
                subrole = axString(hit, kAXSubroleAttribute as String)
                name = axString(hit, kAXTitleAttribute as String) ?? axString(hit, kAXDescriptionAttribute as String)
                if let axWindow = axElement(hit, kAXWindowAttribute as String) {
                    windowTitle = axString(axWindow, kAXTitleAttribute as String) ?? windowTitle
                }
                pressable = axActions(hit).contains(kAXPressAction as String)
            }
        }
        var owner: [String: Any] = [:]
        if let app = stackApp { owner["app"] = app }
        if let ownerPid = axPid ?? stackPid { owner["pid"] = Int(ownerPid) }
        if let instance = stackInstance { owner["processInstance"] = instance }
        if stackWindow > 0 { owner["windowNumber"] = stackWindow }
        if !windowTitle.isEmpty { owner["windowTitle"] = windowTitle }
        if let role { owner["role"] = role }
        if let name { owner["name"] = name }
        owner["pressable"] = pressable
        if isSecurityAgent(stackApp) { owner["securityAgent"] = true }

        var secureEvidence: [String] = []
        if IsSecureEventInputEnabled() { secureEvidence.append("system_secure_input") }
        // A protected control can receive input before the system-wide flag is
        // set; both are evidence, and neither reads the control's value.
        if secureControl(role: role, subrole: subrole) { secureEvidence.append("secure_control") }
        let secure = !secureEvidence.isEmpty
        var decision = "record"
        var gapCode: String?
        if secure {
            decision = "gap"
            gapCode = "SECURE_INPUT"
        } else if stackWindow <= 0 || axPid == nil || axPid != stackPid || excluded(stackApp) {
            decision = "gap"
            gapCode = "CAPTURE_SCOPE_UNVERIFIED"
        } else if stackWindow != focusWindowNumber {
            // The pointer landed on a window that is not the focused one. A
            // plain background click only activates it; a pressable control
            // could be a first-mouse delivery, which macOS does not prove.
            if activation && !pressable && activationRoles.contains(role ?? "") {
                decision = "navigate"
            } else {
                decision = "gap"
                gapCode = "CAPTURE_SCOPE_UNVERIFIED"
            }
        }
        var evidence: [String: Any] = [
            "focusGeneration": focusGeneration, "secure": secure, "owner": owner,
            "decision": decision,
        ]
        if !secureEvidence.isEmpty { evidence["secureEvidence"] = secureEvidence }
        if let gapCode { evidence["gapCode"] = gapCode }
        return evidence
    }

    /** The system authorization UI is not the app that asked for the password. */
    private func isSecurityAgent(_ app: String?) -> Bool {
        guard let app else { return false }
        return app == "com.apple.SecurityAgent"
    }

    /** AX protects a control when its role or subrole names a secure input. */
    private func secureControl(role: String?, subrole: String?) -> Bool {
        (role ?? "").contains("Secure") || (subrole ?? "").contains("Secure")
    }

    private func emitGap(_ code: String, detail: String? = nil) {
        var row: [String: Any] = [
            "kind": "gap", "gapCode": code,
            "t": elapsedMs(), "seen": wallClockMs(), "focusGeneration": focusGeneration,
            "secure": IsSecureEventInputEnabled(),
        ]
        if let detail { row["detail"] = detail }
        emit(row)
    }

    private func focusedElementIsSecure(_ application: NSRunningApplication) -> Bool {
        let axApp = AXUIElementCreateApplication(application.processIdentifier)
        guard let element = axElement(axApp, kAXFocusedUIElementAttribute as String) else { return false }
        let role = axString(element, kAXRoleAttribute as String) ?? ""
        let subrole = axString(element, kAXSubroleAttribute as String) ?? ""
        return secureControl(role: role, subrole: subrole)
    }

    /** The bound instance, or nil when no path identity was requested. */
    private func boundApplication() -> NSRunningApplication? {
        guard let pid else { return nil }
        return NSRunningApplication(processIdentifier: pid)
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
        hover.reset()
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
        // A path-bound recording proves the selected window belongs to the
        // instance named by the caller before any input is attributed to it.
        var identity: [String: Any]?
        if let pid {
            guard let application = boundApplication(), !application.isTerminated,
                  application.bundleIdentifier == app else {
                stop("IDENTITY_MISMATCH", detail: "The bound process is no longer running")
                return
            }
            let owner = windowOwnerPid()
            guard owner == pid else {
                stop("IDENTITY_MISMATCH", detail: "The selected window belongs to another process")
                return
            }
            identity = [
                "pid": Int(pid),
                "bundlePath": bundlePath ?? application.bundleURL?.resolvingSymlinksInPath().path ?? "",
                "windowOwnerPid": Int(owner ?? 0),
            ]
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
        var ready: [String: Any] = ["kind": "ready", "indicator": indicatorEvidence,
                                    "hotkeysFiltered": true, "global": global]
        ready["identity"] = identity
        emit(ready)
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
        if global { return refreshGlobalFocus() }
        let frontmost = NSWorkspace.shared.frontmostApplication
        let target = pid.map { frontmost?.processIdentifier == $0 ? frontmost : nil }
            ?? (frontmost?.bundleIdentifier == app ? frontmost : nil)
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
        // Once a recording is bound to one instance, losing that instance or
        // its window ends the capture instead of re-attributing input.
        if let pid {
            guard let application = boundApplication(), !application.isTerminated,
                  application.bundleIdentifier == app else {
                stop("IDENTITY_CHANGED", detail: "The bound process stopped during recording")
                return
            }
            guard windowOwnerPid() == pid else {
                stop("IDENTITY_CHANGED", detail: "The selected window stopped belonging to the bound process")
                return
            }
        }
        guard CGPreflightListenEventAccess() else {
            if global { emitGap("CAPTURE_GAP", detail: "input_monitoring_lost") }
            stop("INPUT_MONITORING_LOST")
            return
        }
        guard AXIsProcessTrusted() else {
            if global { emitGap("CAPTURE_GAP", detail: "accessibility_lost") }
            stop("ACCESSIBILITY_LOST")
            return
        }
        guard CFMachPortIsValid(hotkeyTap), CGEvent.tapIsEnabled(tap: hotkeyTap) else {
            stop("HOTKEY_TAP_UNAVAILABLE", detail: "The recording hotkey filter became unavailable")
            return
        }
        guard CFMachPortIsValid(tap) else { stop("TAP_UNAVAILABLE"); return }
        if !CGEvent.tapIsEnabled(tap: tap) {
            pointer = RecordingPointer()
            traceMouseLifecycle("tap_interrupted")
            if global { emitGap("STALE_CAPTURE", detail: "tap_interrupted") } else { warn("TAP_INTERRUPTED") }
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        flushPauseBoundary()
        refreshFocus()
        flushHover()
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
        pointer = RecordingPointer()
        hover.reset()
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
        // A helper that fell behind the event queue has lost events. The gap
        // splits any burst and tells the flow not to bridge the hole.
        if global, started != nil, !stopped, pausedAt == nil, event.timestamp > 0 {
            let now = DispatchTime.now().uptimeNanoseconds
            if now > event.timestamp {
                let lag = Double(now - event.timestamp) / 1_000_000_000
                let uptime = ProcessInfo.processInfo.systemUptime
                if lag > 0.5, uptime - lagNotedAt > 2 {
                    lagNotedAt = uptime
                    emitGap("STALE_CAPTURE", detail: "event_lag")
                }
            }
        }
        if type == .mouseMoved {
            receiveHover(event)
            return
        }
        // Any button, wheel or key action ends the current dwell; a later move
        // starts a new one.
        hover.reset()
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            receivePointer(type, event, eventKind: .down)
            return
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:
            receivePointer(type, event, eventKind: .up)
            return
        case .leftMouseDragged, .rightMouseDragged:
            receivePointer(type, event, eventKind: .drag)
            return
        case .scrollWheel:
            receiveScroll(event)
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
        var frontmost: NSRunningApplication?
        if type == .keyDown {
            guard let active = refreshFocus() else { return }
            frontmost = active
            if global {
                _ = checkSecureInput()
            } else {
                guard !checkSecureInput() else { return }
            }
            guard destination <= 0 || destination == Int64(active.processIdentifier) else { return }
        } else {
            // Scope unsupported pointer input to the selected window.
            guard let primary = NSScreen.screens.first else { return }
            let point = NSPoint(x: event.location.x, y: primary.frame.maxY - event.location.y)
            guard indicator?.covers(point) != true else {
                emit(["kind": "boundary"])
                return
            }
            let hit = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
            if global {
                guard hit > 0, hit == focusWindowNumber else {
                    emit(["kind": "boundary"])
                    return
                }
            } else {
                guard hit == window else {
                    emit(["kind": "boundary"])
                    return
                }
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
        // Secure content is never read. One secure event opens the interval; the
        // helper reports why it was secure and the TypeScript engine folds the
        // interval into one manual checkpoint without keeping any content.
        if global, let frontmost {
            let secureControl = focusedElementIsSecure(frontmost)
            if secureInput || secureControl {
                var evidence: [String] = []
                if secureInput { evidence.append("system_secure_input") }
                if secureControl { evidence.append("secure_control") }
                var payload: [String: Any] = [
                    "kind": "text", "secure": true, "secureEvidence": evidence,
                    "t": t, "seen": seen,
                ]
                addFocusEvidence(&payload)
                // addFocusEvidence copies only the system-wide flag; a protected
                // control stays secure even when that flag is false.
                payload["secure"] = true
                emit(payload)
                return
            }
        }
        let special = namedKeys[code]
        if special == nil || special == "space" {
            if modifiers.isEmpty || modifiers == ["shift"] {
                var buffer = [UniChar](repeating: 0, count: 16)
                var length = 0
                event.keyboardGetUnicodeString(maxStringLength: buffer.count,
                                             actualStringLength: &length, unicodeString: &buffer)
                if length > 0 && length <= buffer.count {
                    let chars = String(decoding: buffer.prefix(length), as: UTF16.self)
                    // IME commits and other Unicode text reach the tap as a
                    // printable string. Control characters stay unsupported.
                    let printable = chars.unicodeScalars.allSatisfy { scalar in
                        scalar.value >= 32 && scalar.value != 127 &&
                            !(scalar.value >= 0x80 && scalar.value <= 0x9f)
                    }
                    if printable {
                        let ime = chars.unicodeScalars.contains { $0.value > 126 }
                        var payload: [String: Any] = [
                            "kind": "text", "chars": chars,
                            "t": t, "seen": seen,
                        ]
                        if ime { payload["ime"] = true }
                        if global { addFocusEvidence(&payload) }
                        emit(payload)
                        return
                    }
                }
                warn("UNSUPPORTED_TEXT")
                return
            }
        }
        guard let key = special ?? ansiKeys[code] else { warn("UNSUPPORTED_KEY"); return }
        var payload: [String: Any] = ["kind": "key", "key": key, "modifiers": modifiers, "t": t, "seen": seen]
        if global { addFocusEvidence(&payload) }
        emit(payload)
    }

    /** Adds the front window's evidence to a key/text payload. */
    private func addFocusEvidence(_ payload: inout [String: Any]) {
        payload["focusGeneration"] = focusGeneration
        payload["secure"] = secureInput
        let owner = focusOwner()
        if !owner.isEmpty { payload["owner"] = owner }
    }

    private func focusOwner() -> [String: Any] {
        var owner: [String: Any] = [:]
        if let focusApp { owner["app"] = focusApp }
        if let focusPid { owner["pid"] = Int(focusPid) }
        if let focusInstance { owner["processInstance"] = focusInstance }
        if let focusWindowNumber { owner["windowNumber"] = focusWindowNumber }
        if let focusTitle { owner["windowTitle"] = focusTitle }
        if isSecurityAgent(focusApp) { owner["securityAgent"] = true }
        return owner
    }

    private func registerEvent() -> Bool {
        if events < eventLimit {
            events += 1
            if events == eventLimit {
                if global {
                    emitGap("CAPTURE_GAP", detail: "event_limit")
                } else {
                    warn("EVENT_LIMIT")
                }
            }
        }
        return events <= eventLimit
    }

    private func traceMouseLifecycle(_ event: String, code: String? = nil) {
        guard traceClicks else { return }
        var row: [String: Any] = ["kind": "click_trace", "stage": "native", "event": event,
                                  "targetWindow": window, "seenAtMs": Int(Date().timeIntervalSince1970 * 1000),
                                  "observedUptimeNs": String(DispatchTime.now().uptimeNanoseconds)]
        row["code"] = code
        emit(row)
    }

    private func receivePointer(_ type: CGEventType, _ event: CGEvent, eventKind: PointerObservation.Event) {
        let phase: PointerObservation.Phase
        if stopped || stopReleaseDeadline != nil { phase = .stopping }
        else if started == nil { phase = .preparing }
        else if pausedAt != nil { phase = .paused }
        else { phase = .recording }
        guard traceClicks || phase == .recording else { return }
        if phase == .recording { flushPauseBoundary() }

        let sample = PointerSample(timestamp: event.timestamp, location: event.location,
                                   eventNumber: event.getIntegerValueField(.mouseEventNumber),
                                   clickState: event.getIntegerValueField(.mouseEventClickState))
        let button = event.getIntegerValueField(.mouseEventButtonNumber)
        let screenPoint = eventKind == .down || traceClicks || global ? NSScreen.screens.first.map {
            NSPoint(x: sample.location.x, y: $0.frame.maxY - sample.location.y)
        } : nil
        let hit = screenPoint.map { NSWindow.windowNumber(at: $0, belowWindowWithWindowNumber: 0) }
        let frontmost = traceClicks || !global ? NSWorkspace.shared.frontmostApplication : nil
        var targetAppFrontmost: Bool?
        if !global, let frontmost {
            if let pid {
                targetAppFrontmost = frontmost.processIdentifier == pid
            } else {
                targetAppFrontmost = frontmost.bundleIdentifier == app
            }
        }
        // The top normal window is a diagnostic hint for activation within the same app.
        var frontWindow: Int?
        if !global, hit == window, let frontmost, targetAppFrontmost == true,
           let info = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] {
            let top = info.first {
                ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == frontmost.processIdentifier &&
                ($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
            }
            frontWindow = (top?[kCGWindowNumber as String] as? NSNumber)?.intValue
        }
        let modifiers = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
        let plainClick = modifiers.isEmpty &&
            (type == .leftMouseDown || (type == .rightMouseDown && button == 1))
        let observation = PointerObservation(
            phase: phase, event: eventKind, plainClick: plainClick,
            recorderEvent: event.getIntegerValueField(.eventTargetUnixProcessID) == ownPID ||
                event.getIntegerValueField(.eventSourceUnixProcessID) == ownPID,
            overIndicator: screenPoint.map { indicator?.covers($0) == true } ?? false,
            hitWindow: hit.flatMap { $0 > 0 ? $0 : nil },
            targetWindow: global ? (hit ?? 0) : window,
            targetAppFrontmost: global ? nil : targetAppFrontmost,
            frontWindow: global ? nil : frontWindow, button: button
        )
        var reason = observation.reason
        var click: RecordingPointer.Click?
        var drag: RecordingPointer.Drag?
        switch reason {
        case .awaitingRelease:
            reason = pointer.press(sample, button: button, modifiers: modifierNames(modifiers))
            if global, reason == .awaitingRelease, let screenPoint {
                // Activation is only meaningful for a click; evidence freezes at
                // mouse-down and is never re-read on release.
                pendingPointEvidence = pointerEvidence(screenPoint: screenPoint, activation: true)
            }
        case .unmatchedUp where type == .leftMouseUp || type == .rightMouseUp:
            (reason, click, drag) = pointer.release(sample, modifiers: modifierNames(modifiers))
            if (reason == .accepted || reason == .dragAccepted) && events >= eventLimit { reason = .eventLimit }
        case .dragObserved:
            reason = pointer.drag(sample, modifiers: modifierNames(modifiers))
        case .unsupportedClick, .overlay, .otherWindow, .noWindow:
            if type == .leftMouseDown || type == .rightMouseDown { pointer = RecordingPointer() }
        default:
            break
        }
        if traceClicks {
            emit(observation.trace(sample: sample, reason: reason, down: click?.down,
                                   seenAtMs: Int(Date().timeIntervalSince1970 * 1000),
                                   button: button,
                                   modifierFlags: modifiers.rawValue,
                                   quartzWindow: event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)))
        }
        guard !stopped else { return }
        switch reason {
        case .accepted:
            guard let started, let click, registerEvent() else { return }
            if click.truncated { warn("MULTI_CLICK_TRUNCATED") }
            var emitted: [String: Any] = [
                "kind": "click", "point": [Int(click.down.location.x.rounded()), Int(click.down.location.y.rounded())],
                "count": Int(click.count),
                "t": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
                "seen": Int(Date().timeIntervalSince1970 * 1000),
            ]
            if click.button == 1 { emitted["button"] = "right" }
            if global {
                if let evidence = pendingPointEvidence {
                    for (key, value) in evidence { emitted[key] = value }
                } else {
                    emitted["decision"] = "gap"
                    emitted["gapCode"] = "CAPTURE_SCOPE_UNVERIFIED"
                    emitted["focusGeneration"] = focusGeneration
                    emitted["secure"] = secureInput
                }
                pendingPointEvidence = nil
            }
            if traceClicks { emitted["traceId"] = click.down.traceId }
            emit(emitted)
        case .dragStarted:
            // Announce pickup before the drop so the CLI can bind both endpoints
            // against the tree the gesture started from.
            guard started != nil else { return }
            emit(["kind": "drag_start"])
        case .dragAccepted:
            guard let started, let drag, registerEvent() else { return }
            var emitted: [String: Any] = [
                "kind": "drag",
                "from": [Int(drag.from.location.x.rounded()), Int(drag.from.location.y.rounded())],
                "to": [Int(drag.to.location.x.rounded()), Int(drag.to.location.y.rounded())],
                "path": drag.path.map { [Int($0.location.x.rounded()), Int($0.location.y.rounded())] },
                "durationMs": drag.durationMs,
                "modifiers": drag.modifiers,
                "button": drag.button == 1 ? "right" : "left",
                "t": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
                "seen": Int(Date().timeIntervalSince1970 * 1000),
            ]
            if global {
                if var evidence = pendingPointEvidence {
                    // v2 cannot navigate and drag in one gesture.
                    if evidence["decision"] as? String != "record" {
                        evidence["decision"] = "gap"
                        evidence["gapCode"] = "CAPTURE_SCOPE_UNVERIFIED"
                    }
                    if let number = (evidence["owner"] as? [String: Any])?["windowNumber"] as? Int {
                        emitted["fromWindowNumber"] = number
                    }
                    for (key, value) in evidence { emitted[key] = value }
                } else {
                    emitted["decision"] = "gap"
                    emitted["gapCode"] = "CAPTURE_SCOPE_UNVERIFIED"
                    emitted["focusGeneration"] = focusGeneration
                    emitted["secure"] = secureInput
                }
                pendingPointEvidence = nil
                if let primary = NSScreen.screens.first {
                    let dropPoint = NSPoint(x: drag.to.location.x, y: primary.frame.maxY - drag.to.location.y)
                    let dropWindow = NSWindow.windowNumber(at: dropPoint, belowWindowWithWindowNumber: 0)
                    if dropWindow > 0 { emitted["toWindowNumber"] = dropWindow }
                }
            }
            if traceClicks { emitted["traceId"] = drag.from.traceId }
            emit(emitted)
        case .unsupportedClick:
            if registerEvent() { warn(type == .leftMouseDown ? "UNSUPPORTED_CLICK" : "UNSUPPORTED_EVENT") }
        case .eventLimit:
            _ = registerEvent()
        case .overlay, .otherWindow, .noWindow:
            emit(["kind": "boundary"])
        default:
            break
        }
    }

    private func modifierNames(_ flags: CGEventFlags) -> [String] {
        let names: [(CGEventFlags, String)] = [
            (.maskCommand, "meta"), (.maskControl, "ctrl"), (.maskAlternate, "alt"), (.maskShift, "shift"),
        ]
        return names.compactMap { flag, name in flags.contains(flag) ? name : nil }
    }

    /// An unpressed move becomes a hover step only after the pointer settles in
    /// one small area. The tracker ignores every shorter pass.
    private func receiveHover(_ event: CGEvent) {
        guard started != nil, !stopped, stopReleaseDeadline == nil, pausedAt == nil else {
            hover.reset()
            return
        }
        flushPauseBoundary()
        let destination = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard destination != ownPID, event.getIntegerValueField(.eventSourceUnixProcessID) != ownPID else {
            hover.reset()
            return
        }
        guard refreshFocus() != nil, let primary = NSScreen.screens.first else {
            hover.reset()
            return
        }
        let point = NSPoint(x: event.location.x, y: primary.frame.maxY - event.location.y)
        guard indicator?.covers(point) != true else {
            hover.reset()
            return
        }
        let hit = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
        if global {
            guard let focusWindowNumber, hit == focusWindowNumber else {
                hover.reset()
                return
            }
        } else {
            guard hit == window else {
                hover.reset()
                return
            }
        }
        guard let dwellMs = hover.sample(location: event.location, timestamp: event.timestamp),
              let anchor = hover.location else { return }
        emitHover(dwellMs, point: NSPoint(x: anchor.x, y: primary.frame.maxY - anchor.y))
    }

    /// Called from the session timer: a pointer that stopped moving sends no
    /// further samples, so its dwell would otherwise never be reported.
    private func flushHover() {
        guard started != nil, !stopped, stopReleaseDeadline == nil, pausedAt == nil,
              targetIsFrontmost, let primary = NSScreen.screens.first else {
            hover.reset()
            return
        }
        guard let dwellMs = hover.flush(now: DispatchTime.now().uptimeNanoseconds),
              let anchor = hover.location else { return }
        emitHover(dwellMs, point: NSPoint(x: anchor.x, y: primary.frame.maxY - anchor.y))
    }

    private func emitHover(_ dwellMs: Int, point: NSPoint) {
        guard let started, registerEvent() else { return }
        var payload: [String: Any] = [
            "kind": "hover",
            "point": [Int(point.x.rounded()), Int(point.y.rounded())],
            "dwellMs": max(300, min(60_000, dwellMs)),
            "t": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
            "seen": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if global {
            // A hover outside the focused window is noise, not a step.
            let evidence = pointerEvidence(screenPoint: point, activation: false)
            guard evidence["decision"] as? String == "record" else { return }
            for (key, value) in evidence { payload[key] = value }
        }
        emit(payload)
    }

    /// Wheel input is scoped to the selected window and recorded as line deltas,
    /// which replay posts back through the driver's wheel command.
    private func receiveScroll(_ event: CGEvent) {
        guard let started, !stopped, stopReleaseDeadline == nil, pausedAt == nil else { return }
        flushPauseBoundary()
        let destination = event.getIntegerValueField(.eventTargetUnixProcessID)
        guard destination != ownPID, event.getIntegerValueField(.eventSourceUnixProcessID) != ownPID else { return }
        guard refreshFocus() != nil else { return }
        guard let primary = NSScreen.screens.first else { return }
        let point = NSPoint(x: event.location.x, y: primary.frame.maxY - event.location.y)
        guard indicator?.covers(point) != true else {
            emit(["kind": "boundary"])
            return
        }
        if !global, NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0) != window {
            emit(["kind": "boundary"])
            return
        }
        var deltaY = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
        var deltaX = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
        if deltaX == 0 && deltaY == 0 {
            // Continuous devices report point or fixed-point deltas instead.
            deltaY = Int64(event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1).rounded())
            deltaX = Int64(event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2).rounded())
        }
        if deltaX == 0 && deltaY == 0 {
            deltaY = Int64(event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1).rounded())
            deltaX = Int64(event.getDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2).rounded())
        }
        guard deltaX != 0 || deltaY != 0 else { return }
        guard registerEvent() else { return }
        var payload: [String: Any] = [
            "kind": "scroll",
            "point": [Int(point.x.rounded()), Int(point.y.rounded())],
            "deltaX": Int(deltaX.clamped(to: -scrollDeltaLimit...scrollDeltaLimit)),
            "deltaY": Int(deltaY.clamped(to: -scrollDeltaLimit...scrollDeltaLimit)),
            "phase": scrollPhase(event.getIntegerValueField(.scrollWheelEventScrollPhase)),
            "t": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
            "seen": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if global {
            // Scrolling a window that is not the focused one cannot be replayed
            // as a focused step; the evidence says so and the engine gaps it.
            let evidence = pointerEvidence(screenPoint: point, activation: false)
            for (key, value) in evidence { payload[key] = value }
        }
        emit(payload)
    }

    private func scrollPhase(_ value: Int64) -> String {
        if value & 8 != 0 { return "cancelled" }
        if value & 4 != 0 { return "ended" }
        if value & 2 != 0 { return "changed" }
        if value & 1 != 0 { return "began" }
        return "none"
    }
}

private let scrollDeltaLimit: Int64 = 1000

/// AX roles that denote a window's own surface rather than a control. A click
/// on one of these in an inactive window only activates the window.
private let activationRoles: Set<String> = [
    "AXWindow", "AXSheet", "AXGroup", "AXScrollArea", "AXLayoutArea", "AXSplitGroup", "AXUnknown",
]

private extension Int64 {
    func clamped(to range: ClosedRange<Int64>) -> Int64 {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
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
        // Read-only TCC preflight for `cuekeeper doctor`; it never prompts.
        if args.count == 2, args[1] == "--permissions" {
            let accessibility = AXIsProcessTrusted()
            let inputMonitoring = CGPreflightListenEventAccess()
            print("{\"accessibility\":\(accessibility),\"inputMonitoring\":\(inputMonitoring)}")
            exit(0)
        }
        // Read-only secure input probe for replay hand-off verification. It
        // starts no tap, reads no accessibility tree and needs no TCC grant.
        if args.count == 2, args[1] == "--secure-state" {
            print("{\"secure\":\(IsSecureEventInputEnabled())}")
            exit(0)
        }
        let global = args.count >= 2 && args[1] == "--global"
        var app = ""
        var window = 0
        var seconds: Double
        var index: Int
        if global {
            // Global capture takes no target: `<helper> --global <seconds> ...`.
            guard args.count >= 3, let value = Double(args[2]), (1...3600).contains(value) else { exit(2) }
            seconds = value
            index = 3
        } else {
            guard args.count >= 4, let value = Int(args[2]), value > 0,
                  let duration = Double(args[3]), (1...90).contains(duration) else { exit(2) }
            app = args[1]
            window = value
            seconds = duration
            index = 4
        }
        // Identity switches pair a PID and canonical path with the container's
        // window number; any other token is rejected rather than ignored.
        var switches: [String] = []
        var pid: Int32?
        var appPath: String?
        var exclude = Set<String>()
        while index < args.count {
            switch args[index] {
            case "--no-indicator", "--sound", "--trace-clicks":
                switches.append(args[index])
                index += 1
            case "--pid":
                guard !global, index + 1 < args.count, let value = Int32(args[index + 1]), value > 0 else { exit(2) }
                pid = value
                index += 2
            case "--app-path":
                guard !global, index + 1 < args.count, !args[index + 1].isEmpty else { exit(2) }
                appPath = args[index + 1]
                index += 2
            case "--exclude":
                guard global, index + 1 < args.count else { exit(2) }
                let entries = args[index + 1].split(separator: ",").map {
                    String($0).trimmingCharacters(in: .whitespaces)
                }
                guard !entries.isEmpty, entries.count <= 32 else { exit(2) }
                for entry in entries {
                    guard !entry.isEmpty,
                          entry.range(of: #"^[A-Za-z0-9][A-Za-z0-9.-]*(?:\.[A-Za-z0-9][A-Za-z0-9.-]*)+$"#,
                                      options: .regularExpression) != nil else { exit(2) }
                    exclude.insert(entry)
                }
                index += 2
            default:
                exit(2)
            }
        }
        let capture = Capture(app: app, window: window, pid: pid, bundlePath: appPath,
                              global: global, exclude: exclude,
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
        var observedTypes: [CGEventType] = [.leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp,
                                            .otherMouseDown, .leftMouseDragged, .rightMouseDragged,
                                            .keyDown, .scrollWheel, .mouseMoved]
        if switches.contains("--trace-clicks") { observedTypes += [.otherMouseUp] }
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
