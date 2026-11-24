import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation

private enum SystemDialog {
    private static let host = "com.apple.CoreServicesUIAgent"

    static func owns(_ application: NSRunningApplication) -> Bool {
        application.bundleIdentifier == host &&
            application.bundleURL?.path.hasPrefix("/System/Library/") == true
    }

    // The host can display dialogs without becoming the frontmost application.
    // Quartz supplies owner and bounds without reading the dialog's contents.
    static func isVisible() -> Bool? {
        let owners = Set(NSRunningApplication.runningApplications(withBundleIdentifier: host)
            .filter { owns($0) }.map { $0.processIdentifier })
        if owners.isEmpty { return false }
        guard let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                      kCGNullWindowID) as? [[String: Any]] else { return nil }
        return windows.contains { window in
            guard let pid = (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
                  owners.contains(pid),
                  let bounds = window[kCGWindowBounds as String] as? NSDictionary,
                  let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
            let alpha = (window[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1
            return rect.width > 1 && rect.height > 1 && alpha > 0
        }
    }
}

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
    private var startedUptimeNs: UInt64 = 0
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
    private var focusChangedAtNs: UInt64 = 0
    // The pointer evidence frozen on mouse-down; release uses it unchanged.
    private var pendingPointEvidence: GlobalPointerEvidence?
    private var captureLag = GlobalCaptureLag()
    private var systemDialogVisible = false

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
     * a single-window app is accepted without a frame match. When the app
     * reports no focused window (an inline rename field, a window mid-animation),
     * its main window is the same window and is read instead.
     *
     * A sheet and an inline editor are surfaces of the window they were opened
     * from, and macOS reports the rename editor as its own window with an empty
     * title. That surface is resolved to the window that owns it; when no window
     * can be proved the probe reports no number at all, so the recorder keeps
     * the window the app already proved instead of inventing a scope no replay
     * can find.
     */
    private func focusedWindowInfo(_ application: NSRunningApplication) -> FocusedWindow? {
        let axApp = AXUIElementCreateApplication(application.processIdentifier)
        guard let reported = axElement(axApp, kAXFocusedWindowAttribute as String) ??
                axElement(axApp, kAXMainWindowAttribute as String) else { return nil }
        let transient = isTransientSurface(reported, axApp: axApp)
        guard let axWindow = transient ? owningWindow(reported) : reported else {
            return FocusedWindow(number: nil, title: "")
        }
        let title = axString(axWindow, kAXTitleAttribute as String) ?? ""
        return FocusedWindow(number: windowNumber(for: axWindow, pid: application.processIdentifier),
                             title: title)
    }

    /** The layer-0 CGWindow of one AX window, matched by its frame. */
    private func windowNumber(for axWindow: AXUIElement, pid: Int32) -> Int? {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements],
                                                   kCGNullWindowID) as? [[String: Any]] else { return nil }
        let owned = list.filter {
            ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid &&
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
                return number
            }
        }
        if owned.count == 1, let number = (owned[0][kCGWindowNumber as String] as? NSNumber)?.intValue {
            return number
        }
        return nil
    }

    /**
     * Whether the reported AX window is a surface of another window rather than
     * a window the user can be sent back to. A sheet or a dialog always is, and
     * an untitled one is when the app keeps a titled window it can belong to.
     */
    private func isTransientSurface(_ element: AXUIElement, axApp: AXUIElement) -> Bool {
        let main = axElement(axApp, kAXMainWindowAttribute as String)
        return FocusEvidence.isTransientSurface(
            role: axString(element, kAXRoleAttribute as String),
            subrole: axString(element, kAXSubroleAttribute as String),
            title: axString(element, kAXTitleAttribute as String),
            mainTitle: main.flatMap { axString($0, kAXTitleAttribute as String) },
            isMainWindow: main.map { CFEqual($0, element) } ?? false)
    }

    /** The window a sheet or inline editor was opened from, when AX names one. */
    private func owningWindow(_ element: AXUIElement) -> AXUIElement? {
        if let window = axElement(element, kAXWindowAttribute as String), !CFEqual(window, element) {
            let title = (axString(window, kAXTitleAttribute as String) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !title.isEmpty { return window }
        }
        var node = axElement(element, kAXParentAttribute as String)
        var depth = 0
        while let current = node, depth < 4 {
            if axString(current, kAXRoleAttribute as String) == "AXWindow" { return current }
            node = axElement(current, kAXParentAttribute as String)
            depth += 1
        }
        return nil
    }

    /**
     * Advances the evidence generation when the front app or window changes.
     *
     * A probe that could not read a window number does not clear the window this
     * app process already proved: the app and its process did not change, so the
     * proved window still describes it. Only another app/process or a newly read
     * window number replaces it. Clearing it made a whole typing burst a scope
     * gap per character (Finder's inline rename field).
     */
    private func noteFocus(pid: Int32?, app: String?, window: Int?, title: String?, instance: Int?, report: Bool) {
        let effectiveWindow = FocusEvidence.windowNumber(
            probed: window, pid: pid, app: app,
            previousPid: focusPid, previousApp: focusApp, previousWindow: focusWindowNumber)
        let changed = pid != focusPid || app != focusApp || effectiveWindow != focusWindowNumber
        if !changed {
            // A probe that could not read a title says nothing about the window
            // it kept; an empty title must not retitle a proved window.
            if let title, !title.isEmpty, title != focusTitle {
                focusTitle = title
            }
            return
        }
        focusGeneration += 1
        focusChangedAtNs = DispatchTime.now().uptimeNanoseconds
        focusPid = pid
        focusApp = app
        focusWindowNumber = effectiveWindow
        focusTitle = title
        focusInstance = instance
        guard report, let pid, let app else { return }
        var owner: [String: Any] = ["app": app, "pid": Int(pid)]
        if let instance { owner["processInstance"] = instance }
        if let effectiveWindow { owner["windowNumber"] = effectiveWindow }
        if let title { owner["windowTitle"] = title }
        emit([
            "kind": "focus", "t": elapsedMs(), "seen": wallClockMs(),
            "focusGeneration": focusGeneration, "secure": IsSecureEventInputEnabled(),
            "owner": owner,
        ])
    }

    @discardableResult
    private func refreshGlobalFocus() -> NSRunningApplication? {
        guard !systemDialogVisible else { return nil }
        guard let frontmost = NSWorkspace.shared.frontmostApplication else { return nil }
        guard !SystemDialog.owns(frontmost) else { return nil }
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

    private func refreshSystemDialog() {
        // Finish an in-flight pointer action first. It may be what opened
        // the dialog, even if its button-up is still in the event queue.
        guard global, started != nil, !stopped, pausedAt == nil, stopReleaseDeadline == nil,
              pendingPointEvidence == nil, let visible = SystemDialog.isVisible(),
              visible != systemDialogVisible else { return }
        systemDialogVisible = visible
        hover.reset()
        emit([
            "kind": "system_dialog", "visible": visible,
            "t": elapsedMs(), "seen": wallClockMs(), "focusGeneration": focusGeneration,
            "secure": IsSecureEventInputEnabled(),
        ])
    }

    private func wallClockMs() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    /** Event time: the recording's active clock, with every pause removed. */
    private func elapsedMs() -> Int {
        guard let started else { return 0 }
        return RecordingClock.activeMs(now: ProcessInfo.processInfo.systemUptime, started: started,
                                       pausedAt: pausedAt, totalPaused: totalPaused)
    }

    /** How long the user was paused, reported once the session ends. */
    private func pausedTotalMs() -> Int {
        guard let started else { return 0 }
        return RecordingClock.pausedMs(now: ProcessInfo.processInfo.systemUptime, started: started,
                                       pausedAt: pausedAt, totalPaused: totalPaused)
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
    private func pointerEvidence(point: CGPoint, target: GlobalPointerTarget) -> GlobalPointerEvidence {
        let stackWindow = target.window
        var stackPid: Int32?
        var stackApp: String?
        var stackTitle: String?
        var stackInstance: Int?
        if let stackWindow,
           let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(stackWindow)) as? [[String: Any]],
           let info = list.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == stackWindow }) {
            stackPid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value
            stackTitle = info[kCGWindowName as String] as? String
            if let stackPid {
                let owner = NSRunningApplication(processIdentifier: stackPid)
                stackApp = owner?.bundleIdentifier
                stackInstance = owner.flatMap { launchMillis($0) }
            }
        }
        let targetMatches = stackApp != nil && !excluded(stackApp) &&
            (stackPid.map { target.matches(ownerPID: $0) } ?? false)
        let isFocused = stackWindow != nil && stackWindow == focusWindowNumber &&
            stackPid != nil && stackPid == focusPid
        var axOwnerMatches: Bool?
        var role: String?
        var hitRole: String?
        var subrole: String?
        var name: String?
        var windowTitle = isFocused ? (focusTitle ?? stackTitle) : stackTitle
        var pressable = false
        var menuAction = false
        // A menu is its own Quartz window with no relation to the window the
        // user clicked in. Its item still names the action the user chose, and
        // the action belongs to the app window that was in use when it opened.
        var ownerWindow = stackWindow
        // A queued event can still prove its window after the live hit changed.
        // Only enrich it with AX while the same window is under the pointer.
        if targetMatches, target.canReadAX {
            let system = AXUIElementCreateSystemWide()
            var hit: AXUIElement?
            if AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success, let hit {
                var elementPid: pid_t = 0
                if AXUIElementGetPid(hit, &elementPid) == .success, elementPid > 0 {
                    axOwnerMatches = elementPid == stackPid
                }
                if axOwnerMatches == true {
                    // The click names the file or item it landed on. The raw role
                    // stays available because a secure control is recognised by
                    // the element under the pointer, not by its named ancestor.
                    hitRole = axString(hit, kAXRoleAttribute as String)
                    subrole = axString(hit, kAXSubroleAttribute as String)
                    if let identity = menuItemIdentity(hit) {
                        role = identity.role
                        name = identity.name
                        // Only a menu whose app window can be proved is a step;
                        // a menu surface is never a scope of its own.
                        if let stackPid,
                           let number = menuScopeWindow(pid: stackPid, title: &windowTitle) {
                            ownerWindow = number
                            menuAction = true
                        }
                    } else {
                        let identity = pointerIdentity(hit)
                        role = identity?.role ?? hitRole
                        name = identity?.name
                    }
                    if windowTitle?.isEmpty != false, let axWindow = axElement(hit, kAXWindowAttribute as String) {
                        windowTitle = axString(axWindow, kAXTitleAttribute as String) ?? windowTitle
                    }
                    pressable = axActions(hit).contains(kAXPressAction as String)
                }
            }
        }
        var owner: [String: Any] = ["pressable": pressable]
        if let app = stackApp { owner["app"] = app }
        if let stackPid, stackPid > 0 { owner["pid"] = Int(stackPid) }
        if let instance = stackInstance { owner["processInstance"] = instance }
        if let ownerWindow { owner["windowNumber"] = ownerWindow }
        if let windowTitle { owner["windowTitle"] = windowTitle }
        if let role { owner["role"] = role }
        if let name { owner["name"] = name }
        if isSecurityAgent(stackApp) { owner["securityAgent"] = true }

        var secureEvidence: [String] = []
        if IsSecureEventInputEnabled() { secureEvidence.append("system_secure_input") }
        // A protected control can receive input before the system-wide flag is
        // set; both are evidence, and neither reads the control's value.
        if secureControl(role: hitRole, subrole: subrole) { secureEvidence.append("secure_control") }
        return GlobalPointerEvidence(owner: owner, focusGeneration: focusGeneration, secureEvidence: secureEvidence,
                                     targetMatches: targetMatches, isFocused: isFocused,
                                     axOwnerMatches: axOwnerMatches, menuAction: menuAction)
    }

    /**
     * The menu item a click landed on, named by the item itself. The element
     * under the pointer is usually the item's label, so the menu item above it
     * is the thing a replay presses. A click on the menu's background is not an
     * action and keeps whatever proof the generic path has.
     */
    private func menuItemIdentity(_ hit: AXUIElement) -> PointerIdentity? {
        var node: AXUIElement? = hit
        var depth = 0
        while let current = node, depth < 4 {
            let role = axString(current, kAXRoleAttribute as String)
            if role == "AXMenuItem" {
                return PointerIdentity(role: "AXMenuItem", name: pointerName(current, role: role))
            }
            // A menu surface only ever nests inside a menu, never a window.
            if role == "AXWindow" || role == "AXApplication" || role == "AXMenuBar" { return nil }
            node = axElement(current, kAXParentAttribute as String)
            depth += 1
        }
        return nil
    }

    /**
     * The app window a menu action belongs to: the window that had focus when
     * the menu opened. A menu never becomes a scope of its own, so the window is
     * proved the same way a focus probe would prove it.
     */
    private func menuScopeWindow(pid: Int32, title: inout String?) -> Int? {
        if pid == focusPid, let number = focusWindowNumber {
            if let focusTitle, !focusTitle.isEmpty { title = focusTitle }
            return number
        }
        let axApp = AXUIElementCreateApplication(pid)
        guard let main = axElement(axApp, kAXMainWindowAttribute as String),
              let number = windowNumber(for: main, pid: pid) else { return nil }
        if let label = axString(main, kAXTitleAttribute as String), !label.isEmpty { title = label }
        return number
    }

    /**
     * The element under the pointer with the nearest named item above it. Finder
     * names a file on an enclosing cell or row, or on the static text label
     * named by its value; the field under the pointer is often anonymous.
     */
    private func pointerIdentity(_ hit: AXUIElement) -> PointerIdentity? {
        // A file item is named by its file, not by the columns its row shows.
        if let identity = fileItemIdentity(hit) { return identity }
        let role = axString(hit, kAXRoleAttribute as String)
        let element = PointerElement(role: role, name: pointerName(hit, role: role))
        // The common case is a named hit; do not touch its ancestry then.
        if let name = element.name, !name.isEmpty {
            return PointerIdentityResolver.resolve(hit: element, ancestors: [])
        }
        var ancestors: [PointerElement] = []
        var node = axElement(hit, kAXParentAttribute as String)
        var depth = 0
        while let current = node, depth < 6 {
            let parentRole = axString(current, kAXRoleAttribute as String)
            // A window or application title is a scope, never a target.
            if parentRole == "AXWindow" || parentRole == "AXApplication" { break }
            let ancestor = PointerElement(role: parentRole, name: pointerName(current, role: parentRole))
            ancestors.append(ancestor)
            if let name = ancestor.name, !name.isEmpty,
               let role = ancestor.role, PointerIdentityResolver.itemRoles.contains(role) {
                break
            }
            node = axElement(current, kAXParentAttribute as String)
            depth += 1
        }
        return PointerIdentityResolver.resolve(hit: element, ancestors: ancestors)
    }

    /**
     * The file item a click landed on, named by the file itself.
     *
     * A list view row's own name joins the columns it shows ("今天 21:36 616
     * 字节 JSON"), and the field under the pointer is anonymous. The file's
     * display name comes from AXFilename, then its file URL, then the text
     * field in the row's first (name) column. Nothing else names the item: a
     * row without a file keeps whatever proof the generic path has.
     */
    private func fileItemIdentity(_ hit: AXUIElement) -> PointerIdentity? {
        var node: AXUIElement? = hit
        var row: AXUIElement?
        var filename: String?
        var urlName: String?
        var depth = 0
        while let current = node, depth < 6 {
            let role = axString(current, kAXRoleAttribute as String)
            // A window or application title is a scope, never a target.
            if role == "AXWindow" || role == "AXApplication" { break }
            if filename == nil { filename = nonEmpty(axString(current, kAXFilenameAttribute as String)) }
            if urlName == nil {
                urlName = axString(current, kAXURLAttribute as String).flatMap(fileURLName)
            }
            if row == nil, role == "AXOutlineRow" || role == "AXRow" { row = current }
            node = axElement(current, kAXParentAttribute as String)
            depth += 1
        }
        let column = row.flatMap(nameColumnValue)
        guard let name = PointerFileItem.name(filename: filename, url: urlName, column: column) else { return nil }
        // The row is the item a replay clicks; without one the hit is all we have.
        let carrier = row ?? hit
        guard let role = axString(carrier, kAXRoleAttribute as String), !role.isEmpty else { return nil }
        return PointerIdentity(role: PointerIdentityResolver.snapshotRole(role), name: name)
    }

    /** The text a row's first (name) column shows; later columns are descriptions. */
    private func nameColumnValue(_ row: AXUIElement) -> String? {
        let cells = axElements(row, kAXChildrenAttribute as String).filter {
            axString($0, kAXRoleAttribute as String) == "AXCell"
        }
        // A single cell is an icon or a sidebar row, whose own name already holds
        // the item. A list row has one cell per column and names nothing itself.
        guard cells.count >= 2, let cell = cells.first else { return nil }
        if let value = nonEmpty(axString(cell, kAXValueAttribute as String)) { return value }
        for child in axElements(cell, kAXChildrenAttribute as String) {
            let role = axString(child, kAXRoleAttribute as String)
            guard role == "AXTextField" || role == "AXStaticText" || role == "AXText" else { continue }
            if let label = pointerName(child, role: role) { return label }
            if let value = nonEmpty(axString(child, kAXValueAttribute as String)) { return value }
        }
        return nil
    }

    /** The display name in a file URL, or nil when it names no local file. */
    private func fileURLName(_ raw: String) -> String? {
        guard let url = URL(string: raw), url.isFileURL else { return nil }
        let name = url.lastPathComponent
        return name.isEmpty ? nil : name
    }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return value
    }

    private func axElements(_ element: AXUIElement, _ name: String) -> [AXUIElement] {
        guard let value = axAttribute(element, name), CFGetTypeID(value) == CFArrayGetTypeID(),
              let array = value as? [AXUIElement] else { return [] }
        return array
    }

    /** What an element names itself by; a static text label uses its value. */
    private func pointerName(_ element: AXUIElement, role: String?) -> String? {
        if let title = axString(element, kAXTitleAttribute as String), !title.isEmpty { return title }
        if let description = axString(element, kAXDescriptionAttribute as String), !description.isEmpty {
            return description
        }
        if role == "AXStaticText" || role == "AXText",
           let value = axString(element, kAXValueAttribute as String), !value.isEmpty {
            return value
        }
        return nil
    }

    private func livePointerEvidence(point: NSPoint) -> [String: Any] {
        let window = NSWindow.windowNumber(at: point, belowWindowWithWindowNumber: 0)
        let quartzY = NSScreen.screens.first.map { $0.frame.maxY - point.y } ?? point.y
        let target = GlobalPointerTarget(eventWindow: nil, liveWindow: window > 0 ? window : nil,
                                         destination: nil, predatesFocus: false)
        return pointerEvidence(point: CGPoint(x: point.x, y: quartzY), target: target).fields(forClick: false)
    }

    private func unresolvedPointerEvidence() -> GlobalPointerEvidence {
        let secureEvidence = IsSecureEventInputEnabled() ? ["system_secure_input"] : []
        return GlobalPointerEvidence(owner: [:], focusGeneration: focusGeneration, secureEvidence: secureEvidence,
                                     targetMatches: false, isFocused: false, axOwnerMatches: nil)
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

    /** AX roles that accept typed text. A protected field is one of them. */
    private static let editableRoles: Set<String> = [
        "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXSecureTextField",
    ]

    /**
     * Constant-time evidence about the accessibility focused element: role,
     * label, screen frame and whether it accepts text. Only single attributes
     * are read — never kAXValueAttribute — so a secure field's content never
     * enters the stream, and no window tree is walked.
     */
    private func focusElementEvidence(_ application: NSRunningApplication? = nil) -> [String: Any]? {
        guard let targetPid = focusPid ?? application?.processIdentifier else { return nil }
        let axApp = AXUIElementCreateApplication(targetPid)
        guard let element = axElement(axApp, kAXFocusedUIElementAttribute as String) else { return nil }
        let role = axString(element, kAXRoleAttribute as String)
        let subrole = axString(element, kAXSubroleAttribute as String)
        var evidence: [String: Any] = [:]
        if let role, !role.isEmpty { evidence["role"] = role }
        evidence["editable"] = Self.editableRoles.contains(role ?? "")
        let secure = secureControl(role: role, subrole: subrole)
        if secure {
            // A protected control keeps its role but never a label.
            evidence["secure"] = true
        } else {
            let title = axString(element, kAXTitleAttribute as String)
            let label = title?.isEmpty == false ? title : axString(element, kAXDescriptionAttribute as String)
            if let label, !label.isEmpty { evidence["name"] = String(label.prefix(256)) }
        }
        if let position = axPoint(element, kAXPositionAttribute as String),
           let size = axSize(element, kAXSizeAttribute as String),
           size.width > 0, size.height > 0 {
            evidence["bounds"] = [Int(position.x.rounded()), Int(position.y.rounded()),
                                  Int(size.width.rounded()), Int(size.height.rounded())]
        }
        return evidence.isEmpty ? nil : evidence
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
        // The session summary closes the stream: the engine needs the paused time
        // to tell the recording's net length from its wall-clock length.
        if started != nil { emit(["kind": "stopped", "pausedMs": pausedTotalMs()]) }
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
        startedUptimeNs = DispatchTime.now().uptimeNanoseconds
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
        refreshSystemDialog()
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
        let activeMs = RecordingClock.activeMs(now: now, started: started,
                                               pausedAt: pausedAt, totalPaused: totalPaused)
        indicator?.update(elapsed: activeMs / 1000, paused: pausedAt != nil,
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
            pendingPointEvidence = nil
            traceMouseLifecycle("tap_interrupted")
            if global { emitGap("STALE_CAPTURE", detail: "tap_interrupted") } else { warn("TAP_INTERRUPTED") }
            CGEvent.tapEnable(tap: tap, enable: true)
        }
        flushPauseBoundary()
        refreshSystemDialog()
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
        pendingPointEvidence = nil
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
        switch type {
        case .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel:
            refreshSystemDialog()
        default:
            break
        }
        guard !systemDialogVisible else { return }
        if global, started != nil, !stopped, stopReleaseDeadline == nil, pausedAt == nil,
           captureLag.shouldReport(isKeyDown: type == .keyDown, timestamp: event.timestamp,
                                   now: DispatchTime.now().uptimeNanoseconds) {
            emitGap("STALE_CAPTURE", detail: "event_lag")
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
        guard started != nil, !stopped, stopReleaseDeadline == nil else { return }
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
        let t = elapsedMs()
        let seen = Int(Date().timeIntervalSince1970 * 1000)
        guard type == .keyDown else { warn("UNSUPPORTED_EVENT"); return }

        let flags: [(CGEventFlags, String)] = [
            (.maskCommand, "meta"), (.maskControl, "ctrl"), (.maskAlternate, "alt"), (.maskShift, "shift")
        ]
        let modifiers = flags.compactMap { flag, name in event.flags.contains(flag) ? name : nil }
        // One focused-element read serves the secure check and the evidence
        // attached to whatever this keystroke becomes.
        let keyFocus = global ? focusElementEvidence(frontmost) : nil
        // Secure content is never read. One secure event opens the interval; the
        // helper reports why it was secure and the TypeScript engine folds the
        // interval into one manual checkpoint without keeping any content.
        if global {
            let secureControl = keyFocus?["secure"] as? Bool ?? false
            if secureInput || secureControl {
                var evidence: [String] = []
                if secureInput { evidence.append("system_secure_input") }
                if secureControl { evidence.append("secure_control") }
                var payload: [String: Any] = [
                    "kind": "text", "secure": true, "secureEvidence": evidence,
                    "t": t, "seen": seen,
                ]
                addFocusEvidence(&payload, focus: keyFocus)
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
                        if global { addFocusEvidence(&payload, focus: keyFocus) }
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
        if global { addFocusEvidence(&payload, focus: keyFocus) }
        emit(payload)
    }

    /** Adds the front window's evidence to a key/text payload. */
    private func addFocusEvidence(_ payload: inout [String: Any], focus: [String: Any]? = nil) {
        payload["focusGeneration"] = focusGeneration
        payload["secure"] = secureInput
        let owner = focusOwner()
        if !owner.isEmpty { payload["owner"] = owner }
        // The focused element is read here, once per event, with attribute
        // calls only: the TypeScript side can then name the typing target
        // without reading the window tree.
        if let focus = focus ?? focusElementEvidence() { payload["focus"] = focus }
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
        if global, reason == .noWindow, plainClick {
            // Keep the press/release pair even when its scope is unresolved,
            // so the gap carries the same point, count and button as a click.
            reason = .awaitingRelease
        }
        var click: RecordingPointer.Click?
        var drag: RecordingPointer.Drag?
        switch reason {
        case .awaitingRelease:
            reason = pointer.press(sample, button: button, modifiers: modifierNames(modifiers))
            if global, reason == .awaitingRelease {
                let eventWindow = event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent)
                let targetPID = Int32(exactly: event.getIntegerValueField(.eventTargetUnixProcessID))
                let target = GlobalPointerTarget(
                    eventWindow: (1...Int64(Int32.max)).contains(eventWindow) ? Int(eventWindow) : nil,
                    liveWindow: observation.hitWindow,
                    destination: targetPID.flatMap { $0 > 0 ? $0 : nil },
                    predatesFocus: sample.timestamp > 0 && sample.timestamp < focusChangedAtNs
                )
                pendingPointEvidence = pointerEvidence(point: sample.location, target: target)
            }
        case .unmatchedUp where type == .leftMouseUp || type == .rightMouseUp:
            (reason, click, drag) = pointer.release(sample, modifiers: modifierNames(modifiers))
            if (reason == .accepted || reason == .dragAccepted) && events >= eventLimit { reason = .eventLimit }
        case .dragObserved:
            reason = pointer.drag(sample, modifiers: modifierNames(modifiers))
        case .unsupportedClick, .overlay, .otherWindow, .noWindow:
            if type == .leftMouseDown || type == .rightMouseDown {
                pointer = RecordingPointer()
                pendingPointEvidence = nil
            }
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
            guard started != nil, let click, registerEvent() else { return }
            if click.truncated { warn("MULTI_CLICK_TRUNCATED") }
            // A pointer timestamp is wall uptime, so the paused time has to be
            // removed here too: a click after a pause belongs on the same active
            // clock as the keys and scrolls around it.
            let captureTime = global
                ? click.elapsedMilliseconds(since: startedUptimeNs)
                    .map { max(0, $0 - Int((totalPaused * 1000).rounded())) }
                : nil
            let evidence = global ? (pendingPointEvidence ?? unresolvedPointerEvidence()) : nil
            pendingPointEvidence = nil
            var emitted = click.payload(t: captureTime ?? elapsedMs(), seen: wallClockMs(), evidence: evidence)
            // The click's focus evidence names the control that will receive
            // typing next, so the TypeScript side can bind text without a tree
            // read and can retarget a container click to that control.
            if global, let focus = focusElementEvidence() { emitted["focus"] = focus }
            if traceClicks { emitted["traceId"] = click.down.traceId }
            emit(emitted)
        case .dragStarted:
            // Announce pickup before the drop so the CLI can bind both endpoints
            // against the tree the gesture started from.
            guard started != nil else { return }
            emit(["kind": "drag_start"])
        case .dragAccepted:
            guard started != nil, let drag, registerEvent() else { return }
            var emitted: [String: Any] = [
                "kind": "drag",
                "from": [Int(drag.from.location.x.rounded()), Int(drag.from.location.y.rounded())],
                "to": [Int(drag.to.location.x.rounded()), Int(drag.to.location.y.rounded())],
                "path": drag.path.map { [Int($0.location.x.rounded()), Int($0.location.y.rounded())] },
                "durationMs": drag.durationMs,
                "modifiers": drag.modifiers,
                "button": drag.button == 1 ? "right" : "left",
                "t": elapsedMs(),
                "seen": Int(Date().timeIntervalSince1970 * 1000),
            ]
            if global {
                let evidence = pendingPointEvidence ?? unresolvedPointerEvidence()
                // v2 cannot navigate and drag in one gesture.
                if let number = evidence.owner["windowNumber"] as? Int {
                    emitted["fromWindowNumber"] = number
                }
                for (key, value) in evidence.fields(forClick: false) { emitted[key] = value }
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
        if eventKind == .up {
            refreshSystemDialog()
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
        guard !systemDialogVisible, started != nil, !stopped, stopReleaseDeadline == nil, pausedAt == nil,
              targetIsFrontmost, let primary = NSScreen.screens.first else {
            hover.reset()
            return
        }
        guard let dwellMs = hover.flush(now: DispatchTime.now().uptimeNanoseconds),
              let anchor = hover.location else { return }
        emitHover(dwellMs, point: NSPoint(x: anchor.x, y: primary.frame.maxY - anchor.y))
    }

    private func emitHover(_ dwellMs: Int, point: NSPoint) {
        guard started != nil, registerEvent() else { return }
        var payload: [String: Any] = [
            "kind": "hover",
            "point": [Int(point.x.rounded()), Int(point.y.rounded())],
            "dwellMs": max(300, min(60_000, dwellMs)),
            "t": elapsedMs(),
            "seen": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if global {
            // A hover outside the focused window is noise, not a step.
            let evidence = livePointerEvidence(point: point)
            guard evidence["decision"] as? String == "record" else { return }
            for (key, value) in evidence { payload[key] = value }
        }
        emit(payload)
    }

    /// Wheel input is scoped to the selected window and recorded as line deltas,
    /// which replay posts back through the driver's wheel command.
    private func receiveScroll(_ event: CGEvent) {
        guard started != nil, !stopped, stopReleaseDeadline == nil, pausedAt == nil else { return }
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
            "t": elapsedMs(),
            "seen": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if global {
            // Scrolling a window that is not the focused one cannot be replayed
            // as a focused step; the evidence says so and the engine gaps it.
            let evidence = livePointerEvidence(point: point)
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


@MainActor
private enum ReplayIndicatorMode {
    static func run() {
        let application = NSApplication.shared
        _ = application.setActivationPolicy(.accessory)
        application.finishLaunching()
        let indicator = RecordingIndicator(mode: .replay)
        if let detail = indicator.show() {
            FileHandle.standardError.write(Data("replay indicator: \(detail)\n".utf8))
        }
        indicator.update(elapsed: 0, paused: false, starting: false)
        let hotkey = installHotkey()
        FileHandle.standardOutput.write(Data("{\"event\":\"ready\",\"hotkey\":\(hotkey)}\n".utf8))
        signal(SIGTERM) { _ in exit(0) }
        signal(SIGINT) { _ in exit(0) }
        let start = Date()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler {
            MainActor.assumeIsolated {
                indicator.update(elapsed: Int(Date().timeIntervalSince(start)), paused: false, starting: false)
            }
        }
        timer.resume()
        application.run()
    }

    /// ⌃⌥X cancels the replay; the chord comes from the recording controls.
    private static func installHotkey() -> Bool {
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: 1 << CGEventType.keyDown.rawValue,
            callback: { _, type, event, _ in
                if type == .keyDown,
                   event.getIntegerValueField(.keyboardEventKeycode) == 7,
                   event.flags.contains([.maskControl, .maskAlternate]) {
                    FileHandle.standardOutput.write(Data("{\"event\":\"cancel\"}\n".utf8))
                    exit(0)
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: nil
        ), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            return false
        }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        return CGEvent.tapIsEnabled(tap: tap)
    }
}

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
        if args.count == 2, args[1] == "--system-dialog-state" {
            guard let visible = SystemDialog.isVisible() else { exit(1) }
            print("{\"visible\":\(visible)}")
            exit(0)
        }
        // Replay overlay: edge particles in blue, cancelled only by ⌃⌥X.
        // It shares this binary so it reuses the recorder's TCC grants.
        if args.count == 2, args[1] == "--replay-indicator" {
            ReplayIndicatorMode.run()
            return
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
