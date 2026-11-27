import Foundation

struct PointerSample {
    let timestamp: UInt64
    let location: CGPoint
    let eventNumber: Int64
    let clickState: Int64

    var traceId: String { "\(timestamp):\(eventNumber)" }

    func squaredDistance(to other: PointerSample) -> CGFloat {
        let x = location.x - other.location.x
        let y = location.y - other.location.y
        return x * x + y * y
    }
}

/// What the tap callback was doing and what it cost, plus every time the system
/// disabled the tap because a callback blocked too long.
///
/// macOS disables an event tap whose callback overruns its budget, and every
/// event until the tap is re-enabled is lost. Two facts therefore have to be
/// told apart: a *slow callback* that finished (diagnosis only — nothing was
/// lost yet, so no gap), and a *disabled tap* (always a gap, because nothing
/// about the interval it covered can be proven to have been observed). The
/// diagnostic keeps the operation that was running and its duration, so the
/// next recording names the work that blocked instead of only the symptom.
struct TapWatchdog {
    /// A callback above this is reported. The system's own disable threshold is
    /// about a second, so this is where the recorder says it is getting close.
    static let slowCallbackMs = 250

    /// The diagnostic of one disable: how often it happened, the callback that
    /// preceded it, and what that callback was processing.
    struct Interruption {
        let count: Int
        let lastCallbackMs: Int
        let lastOperation: String
        let reason: String
    }

    private var startedAt: UInt64 = 0
    private var running = false
    private(set) var operation = "idle"
    private(set) var callbackMs = 0
    private(set) var lastCallbackMs = 0
    private(set) var lastOperation = "idle"
    private(set) var slowCallbacks = 0
    private(set) var interruptions = 0

    mutating func begin(_ operation: String, now: UInt64) {
        self.operation = operation
        startedAt = now
        running = true
    }

    /// Ends the callback and returns its duration. A clock that did not advance
    /// reads as zero, never as a negative duration.
    @discardableResult
    mutating func end(now: UInt64) -> Int {
        let elapsed = running && now > startedAt ? now - startedAt : 0
        running = false
        callbackMs = Int(elapsed / 1_000_000)
        lastCallbackMs = callbackMs
        if !operation.isEmpty { lastOperation = operation }
        return callbackMs
    }

    /// How long the running callback has taken so far; zero when no callback is
    /// being timed, which is what work outside the tap reports.
    func elapsedMs(now: UInt64) -> Int {
        guard running, now > startedAt else { return 0 }
        return Int((now - startedAt) / 1_000_000)
    }

    /// Whether this callback should be reported as slow. Counting it keeps the
    /// caller's warning bounded without losing the number.
    mutating func noteSlowCallback() -> Int {
        slowCallbacks += 1
        return slowCallbacks
    }

    /// The system disabled the tap. Always an interruption: the diagnostic names
    /// the callback that was running before the disable notification.
    mutating func interrupted(reason: String) -> Interruption {
        interruptions += 1
        return Interruption(count: interruptions, lastCallbackMs: lastCallbackMs,
                            lastOperation: lastOperation, reason: reason)
    }
}

struct GlobalCaptureLag {
    private var lastGapAt: UInt64 = 0
    private var firstEventAt: UInt64 = 0

    mutating func shouldReport(isKeyDown: Bool, timestamp: UInt64, now: UInt64) -> Bool {
        if firstEventAt == 0 { firstEventAt = now }
        // Installing the tap replays whatever the system queued meanwhile. Those
        // events carry old timestamps but nothing was lost, so the first second
        // of the session is exempt from the late-key rule.
        guard now > firstEventAt + 1_000_000_000 else { return false }
        // A late key depends on live focus. Pointer actions carry their own
        // location and scope evidence, and interruptions are reported separately.
        guard isKeyDown, timestamp > 0, now > timestamp, now - timestamp > 500_000_000,
              now > lastGapAt, now - lastGapAt > 2_000_000_000 else { return false }
        lastGapAt = now
        return true
    }
}

/// Quartz can name the window that received a queued press. If that field is
/// absent, a live hit is usable only if focus has not advanced past the press.
struct GlobalPointerTarget {
    let eventWindow: Int?
    let liveWindow: Int?
    let destination: Int32?
    let predatesFocus: Bool

    var window: Int? { eventWindow ?? (predatesFocus ? nil : liveWindow) }
    var canReadAX: Bool { !predatesFocus && window != nil && window == liveWindow }

    func matches(ownerPID: Int32) -> Bool {
        window != nil && (destination == nil || destination == ownerPID)
    }
}

struct GlobalPointerEvidence {
    let owner: [String: Any]
    let focusGeneration: Int
    let secureEvidence: [String]
    let targetMatches: Bool
    let isFocused: Bool
    // nil means AX could not resolve an element; false means it contradicted Quartz.
    let axOwnerMatches: Bool?
    // A click on a menu item: the menu is a separate window, so the item's
    // window evidence is the app window that opened it, never the menu itself.
    var menuAction = false

    private static let activationRoles: Set<String> = [
        "AXWindow", "AXSheet", "AXGroup", "AXScrollArea", "AXLayoutArea", "AXSplitGroup", "AXUnknown",
    ]

    func fields(forClick: Bool) -> [String: Any] {
        var fields: [String: Any] = [
            "owner": owner, "focusGeneration": focusGeneration, "secure": !secureEvidence.isEmpty,
        ]
        if !secureEvidence.isEmpty {
            fields["secureEvidence"] = secureEvidence
            fields["decision"] = "gap"
            fields["gapCode"] = "SECURE_INPUT"
        } else if menuAction && targetMatches && axOwnerMatches == true {
            // A menu action is a real press on the app it belongs to: the menu
            // item names the step, and the window that opened the menu is the
            // scope. Treating the menu surface as an unfocused window made every
            // context-menu choice a capture gap.
            fields["decision"] = "record"
        } else if targetMatches && isFocused && (axOwnerMatches == true || (forClick && axOwnerMatches == nil)) {
            fields["decision"] = "record"
        } else if targetMatches && !isFocused && axOwnerMatches == true && forClick &&
                    owner["pressable"] as? Bool == false &&
                    Self.activationRoles.contains(owner["role"] as? String ?? "") {
            // A click on the surface of a background window only activates it.
            fields["decision"] = "navigate"
        } else {
            fields["decision"] = "gap"
            fields["gapCode"] = "CAPTURE_SCOPE_UNVERIFIED"
        }
        return fields
    }
}

/**
 * Turns a stream of unpressed pointer moves into at most one hover per dwell.
 * A dwell starts at the first sample, survives movement inside a small radius,
 * and is reported once it reaches the minimum duration. `flush` handles the
 * common case where the pointer stops moving and no further sample arrives.
 */
struct HoverTracker {
    static let minimumNs: UInt64 = 300_000_000
    static let radiusSquared: CGFloat = 9

    private struct Dwell {
        /// Where the dwell began; the radius is measured from here so a slow
        /// drift cannot walk the dwell across the screen.
        let origin: CGPoint
        /// The most recent sample inside the radius, which is what gets reported.
        var location: CGPoint
        let started: UInt64
        var emitted: Bool
    }

    private var dwell: Dwell?

    /// The latest valid position of the current dwell, for the emitted event.
    var location: CGPoint? { dwell?.location }

    mutating func reset() {
        dwell = nil
    }

    mutating func sample(location: CGPoint, timestamp: UInt64) -> Int? {
        guard let current = dwell, timestamp >= current.started,
              current.origin.squaredDistance(to: location) <= Self.radiusSquared else {
            dwell = Dwell(origin: location, location: location, started: timestamp, emitted: false)
            return nil
        }
        // The pointer moved inside the dwell radius: keep the start and the
        // clock, but report where it actually stopped.
        dwell?.location = location
        guard !current.emitted, timestamp - current.started >= Self.minimumNs else { return nil }
        dwell?.emitted = true
        return Int((timestamp - current.started) / 1_000_000)
    }

    mutating func flush(now: UInt64) -> Int? {
        guard let current = dwell, !current.emitted, now >= current.started,
              now - current.started >= Self.minimumNs else { return nil }
        dwell?.emitted = true
        return Int((now - current.started) / 1_000_000)
    }
}

/**
 * The hover step a dwell reports, in both coordinate spaces the recorder needs.
 *
 * A flow stores a pointer position the same way a click does: Quartz screen
 * points with the origin at the top-left, which is what the replay driver's
 * `--xy` takes. Window hit tests and the live pointer evidence need AppKit
 * points with the origin at the bottom-left. Mapping the two here, once, is
 * what keeps a hover from being written mirrored.
 */
struct HoverEmission {
    let dwellMs: Int
    /// Quartz screen point (origin top-left) — the one that goes into the flow.
    let point: CGPoint
    /// AppKit screen point (origin bottom-left) — only for hit tests.
    let hitPoint: CGPoint

    init(dwellMs: Int, screenPoint: CGPoint, primaryScreenHeight: CGFloat) {
        self.dwellMs = dwellMs
        point = screenPoint
        hitPoint = CGPoint(x: screenPoint.x, y: primaryScreenHeight - screenPoint.y)
    }

    var payloadPoint: [Int] {
        [Int(point.x.rounded()), Int(point.y.rounded())]
    }

    func payload(t: Int, seen: Int, evidence: [String: Any] = [:]) -> [String: Any] {
        var row: [String: Any] = [
            "kind": "hover",
            "point": payloadPoint,
            "dwellMs": max(300, min(60_000, dwellMs)),
            "t": t,
            "seen": seen,
        ]
        for (key, value) in evidence { row[key] = value }
        return row
    }
}

/**
 * The hover half of a capture session: a pointer that settles becomes at most
 * one hover step.
 *
 * Both ways a dwell can be reported — the sample that reaches the threshold and
 * the timer that notices the pointer stopped — ask this type, and it owns the
 * tracker, so no call site can pass the flipped point and no dwell can be
 * reported twice. Everything except the AppKit guards and the emit itself is
 * decided here, which is what the offline pointer suite drives.
 */
struct HoverRecorder {
    private var tracker = HoverTracker()

    mutating func reset() {
        tracker.reset()
    }

    /// The sample-triggered path: a move that completes the dwell.
    mutating func sample(location: CGPoint, timestamp: UInt64,
                         primaryScreenHeight: CGFloat) -> HoverEmission? {
        guard let dwellMs = tracker.sample(location: location, timestamp: timestamp),
              let anchor = tracker.location else { return nil }
        return HoverEmission(dwellMs: dwellMs, screenPoint: anchor,
                             primaryScreenHeight: primaryScreenHeight)
    }

    /// The timer path: the pointer stopped moving, so no further sample arrives.
    mutating func flush(now: UInt64, primaryScreenHeight: CGFloat) -> HoverEmission? {
        guard let dwellMs = tracker.flush(now: now), let anchor = tracker.location else { return nil }
        return HoverEmission(dwellMs: dwellMs, screenPoint: anchor,
                             primaryScreenHeight: primaryScreenHeight)
    }
}

private extension CGPoint {
    func squaredDistance(to other: CGPoint) -> CGFloat {
        let x = self.x - other.x
        let y = self.y - other.y
        return x * x + y * y
    }
}

struct PointerObservation {
    enum Phase: String { case preparing, recording, paused, stopping }
    enum Event: String { case down, up, drag }
    enum Scope: String { case activation, content, overlay, otherWindow = "other_window", unresolved }
    enum Reason: String {
        case beforeReady = "before_ready", paused, stopping
        case recorderEvent = "recorder_event", overlay, otherWindow = "other_window", noWindow = "no_window"
        case unsupportedClick = "unsupported_click", eventLimit = "event_limit"
        case awaitingRelease = "awaiting_release", unmatchedUp = "unmatched_up", dragObserved = "drag_observed"
        case dragStarted = "drag_started", dragging, dragAccepted = "drag_accepted", accepted
        case duplicateDown = "duplicate_down"

        var suppressed: Bool {
            self == .duplicateDown
        }
    }

    let phase: Phase
    let event: Event
    let plainClick: Bool
    let recorderEvent: Bool
    let overIndicator: Bool
    let hitWindow: Int?
    let targetWindow: Int
    let targetAppFrontmost: Bool?
    let frontWindow: Int?
    let button: Int64

    var scope: Scope {
        if overIndicator { return .overlay }
        guard let hitWindow else { return .unresolved }
        guard hitWindow == targetWindow else { return .otherWindow }
        if targetAppFrontmost == false || (frontWindow != nil && frontWindow != targetWindow) { return .activation }
        return .content
    }

    var reason: Reason {
        switch phase {
        case .preparing: return .beforeReady
        case .paused: return .paused
        case .stopping: return .stopping
        case .recording: break
        }
        if recorderEvent { return .recorderEvent }
        switch event {
        case .up: return .unmatchedUp
        case .drag: return .dragObserved
        case .down: break
        }
        switch scope {
        case .overlay: return .overlay
        case .otherWindow: return .otherWindow
        case .unresolved: return .noWindow
        case .activation, .content: break
        }
        guard plainClick else { return .unsupportedClick }
        return .awaitingRelease
    }

    func trace(sample: PointerSample, reason: Reason, down: PointerSample? = nil,
               seenAtMs: Int, button: Int64, modifierFlags: UInt64, quartzWindow: Int64) -> [String: Any] {
        let decision: String
        switch reason {
        case .accepted, .dragAccepted: decision = "accepted"
        case .awaitingRelease, .unmatchedUp, .dragObserved, .dragStarted, .dragging: decision = "observed"
        default: decision = "filtered"
        }
        var row: [String: Any] = [
            "kind": "click_trace", "stage": "native", "event": event.rawValue, "id": sample.traceId,
            "timestampNs": String(sample.timestamp), "seenAtMs": seenAtMs,
            "point": [Double(sample.location.x), Double(sample.location.y)],
            "eventNumber": sample.eventNumber, "button": button, "clickState": sample.clickState,
            "clickCount": sample.clickState, "modifierFlags": modifierFlags, "suppressed": reason.suppressed,
            "quartzWindow": quartzWindow, "targetWindow": targetWindow, "phase": phase.rawValue,
            "scope": scope.rawValue, "decision": decision, "reason": reason.rawValue,
        ]
        row["downId"] = down?.traceId
        row["hitWindow"] = hitWindow
        row["targetAppFrontmost"] = targetAppFrontmost
        row["frontWindow"] = frontWindow
        return row
    }
}

struct RecordingPointer {
    typealias Reason = PointerObservation.Reason

    struct Click {
        let down: PointerSample
        let button: Int64
        let count: Int64
        let truncated: Bool

        func payload(t: Int, seen: Int, evidence: GlobalPointerEvidence? = nil) -> [String: Any] {
            var row = evidence?.fields(forClick: true) ?? [:]
            row["kind"] = "click"
            row["point"] = [Int(down.location.x.rounded()), Int(down.location.y.rounded())]
            row["count"] = Int(count)
            if evidence != nil || button == 1 { row["button"] = button == 1 ? "right" : "left" }
            row["t"] = t
            row["seen"] = seen
            return row
        }

        func elapsedMilliseconds(since start: UInt64) -> Int? {
            guard down.timestamp != 0 else { return nil }
            return down.timestamp > start ? Int((down.timestamp - start) / 1_000_000) : 0
        }
    }

    struct Drag {
        let from: PointerSample
        let to: PointerSample
        let button: Int64
        let modifiers: [String]
        /// Intermediate samples, sampled by distance or time. Endpoints are not repeated here.
        let path: [PointerSample]
        let durationMs: Int
    }

    private struct Press {
        let down: PointerSample
        let button: Int64
        let count: Int64
        let truncated: Bool
        let modifiers: [String]
        var eventNumbers: Set<Int64>
    }

    private struct DragState {
        let from: PointerSample
        let button: Int64
        var modifiers: [String]
        var path: [PointerSample]
        var last: PointerSample
    }

    private static let debounceNs: UInt64 = 120_000_000
    private static let maxDistanceSquared: CGFloat = 9
    private static let dragSampleDistanceSquared: CGFloat = 64
    private static let dragSampleIntervalNs: UInt64 = 16_000_000
    private static let dragPathLimit = 64
    private static let maxCount: Int64 = 3
    private var lastDown: PointerSample?
    private var pending: Press?
    private var dragState: DragState?

    mutating func press(_ sample: PointerSample, button: Int64, modifiers: [String] = []) -> Reason {
        dragState = nil
        let rawCount = button == 0 ? max(sample.clickState, 1) : 1
        let count = min(rawCount, Self.maxCount)
        if button == 0, sample.clickState <= 1 {
            defer { lastDown = sample }
            if let lastDown, sample.timestamp >= lastDown.timestamp,
               sample.timestamp - lastDown.timestamp < Self.debounceNs,
               sample.squaredDistance(to: lastDown) < Self.maxDistanceSquared {
                // A repeated down can have its own event number and matching up.
                pending?.eventNumbers.insert(sample.eventNumber)
                return .duplicateDown
            }
        }
        pending = Press(down: sample, button: button, count: count, truncated: rawCount > Self.maxCount,
                        modifiers: modifiers, eventNumbers: [sample.eventNumber])
        return .awaitingRelease
    }

    /**
     * Collects one sample per 8 points or 16 ms once the press leaves the drag
     * threshold. The first crossing emits `dragStarted` so the recorder can read
     * the pre-drop tree before the source row moves away.
     */
    mutating func drag(_ sample: PointerSample, modifiers: [String] = []) -> Reason {
        guard let pending else { return .dragObserved }
        var started = false
        if dragState == nil {
            guard sample.timestamp >= pending.down.timestamp,
                  sample.squaredDistance(to: pending.down) > Self.maxDistanceSquared else { return .dragObserved }
            dragState = DragState(from: pending.down, button: pending.button, modifiers: pending.modifiers,
                                  path: [], last: pending.down)
            started = true
        }
        guard var state = dragState else { return .dragObserved }
        if !modifiers.isEmpty {
            // Modifiers can be pressed after the mouse-down (Option-drag copy).
            let order = ["meta", "ctrl", "alt", "shift"]
            state.modifiers = order.filter { state.modifiers.contains($0) || modifiers.contains($0) }
        }
        let moved = sample.squaredDistance(to: state.last) >= Self.dragSampleDistanceSquared
        let elapsed = sample.timestamp >= state.last.timestamp &&
            sample.timestamp - state.last.timestamp >= Self.dragSampleIntervalNs
        if moved || elapsed {
            if state.path.count < Self.dragPathLimit { state.path.append(sample) }
            state.last = sample
        }
        dragState = state
        return started ? .dragStarted : .dragging
    }

    mutating func release(_ sample: PointerSample, modifiers: [String] = []) -> (reason: Reason, click: Click?, drag: Drag?) {
        guard let pending else { return (.unmatchedUp, nil, nil) }
        if let state = dragState {
            dragState = nil
            self.pending = nil
            let held = Array(Set(state.modifiers + modifiers)).sorted()
            return (.dragAccepted, nil, Drag(
                from: state.from, to: sample, button: state.button, modifiers: held,
                path: state.path, durationMs: Self.milliseconds(from: state.from, to: sample)))
        }
        guard pending.eventNumbers.contains(sample.eventNumber),
              sample.timestamp >= pending.down.timestamp else { return (.unmatchedUp, nil, nil) }
        self.pending = nil
        // A press and release far apart is a drag even when no dragged event was
        // delivered (fast gestures can coalesce).
        if sample.squaredDistance(to: pending.down) > Self.maxDistanceSquared {
            return (.dragAccepted, nil, Drag(
                from: pending.down, to: sample, button: pending.button, modifiers: pending.modifiers,
                path: [], durationMs: Self.milliseconds(from: pending.down, to: sample)))
        }
        return (.accepted, Click(down: pending.down, button: pending.button,
                                 count: pending.count, truncated: pending.truncated), nil)
    }

    private static func milliseconds(from: PointerSample, to: PointerSample) -> Int {
        guard to.timestamp >= from.timestamp else { return 0 }
        return Int((to.timestamp - from.timestamp) / 1_000_000)
    }
}
