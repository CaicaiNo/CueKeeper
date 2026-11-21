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
        let location: CGPoint
        let started: UInt64
        var emitted: Bool
    }

    private var dwell: Dwell?

    var location: CGPoint? { dwell?.location }

    mutating func reset() {
        dwell = nil
    }

    mutating func sample(location: CGPoint, timestamp: UInt64) -> Int? {
        guard let current = dwell, timestamp >= current.started,
              current.location.squaredDistance(to: location) <= Self.radiusSquared else {
            dwell = Dwell(location: location, started: timestamp, emitted: false)
            return nil
        }
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
