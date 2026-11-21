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

struct PointerObservation {
    enum Phase: String { case preparing, recording, paused, stopping }
    enum Event: String { case down, up, drag }
    enum Scope: String { case activation, content, overlay, otherWindow = "other_window", unresolved }
    enum Reason: String {
        case beforeReady = "before_ready", paused, stopping
        case recorderEvent = "recorder_event", overlay, otherWindow = "other_window", noWindow = "no_window"
        case unsupportedClick = "unsupported_click", eventLimit = "event_limit"
        case awaitingRelease = "awaiting_release", unmatchedUp = "unmatched_up", dragObserved = "drag_observed", accepted
        case duplicateDown = "duplicate_down", multiClickCollapsed = "multi_click_collapsed", dragSkipped = "drag_skipped"

        var suppressed: Bool {
            self == .duplicateDown || self == .multiClickCollapsed || self == .dragSkipped
        }

        var warning: String? {
            switch self {
            case .multiClickCollapsed: return "MULTI_CLICK_COLLAPSED"
            case .dragSkipped: return "DRAG_SKIPPED"
            default: return nil
            }
        }
    }

    let phase: Phase
    let event: Event
    let plainLeftClick: Bool
    let recorderEvent: Bool
    let overIndicator: Bool
    let hitWindow: Int?
    let targetWindow: Int
    let targetAppFrontmost: Bool?
    let frontWindow: Int?

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
        guard plainLeftClick else { return .unsupportedClick }
        return .awaitingRelease
    }

    func trace(sample: PointerSample, reason: Reason, down: PointerSample? = nil,
               seenAtMs: Int, button: Int64, modifierFlags: UInt64, quartzWindow: Int64) -> [String: Any] {
        let decision: String
        switch reason {
        case .accepted: decision = "accepted"
        case .awaitingRelease, .unmatchedUp, .dragObserved: decision = "observed"
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
    private struct Press {
        let down: PointerSample
        var eventNumbers: Set<Int64>
    }

    private static let debounceNs: UInt64 = 120_000_000
    private static let maxDistanceSquared: CGFloat = 9
    private var lastDown: PointerSample?
    private var pending: Press?

    mutating func press(_ sample: PointerSample) -> Reason {
        if sample.clickState > 1 { return .multiClickCollapsed }
        defer { lastDown = sample }
        if let lastDown, sample.timestamp >= lastDown.timestamp,
           sample.timestamp - lastDown.timestamp < Self.debounceNs,
           sample.squaredDistance(to: lastDown) < Self.maxDistanceSquared {
            // A repeated down can have its own event number and matching up.
            pending?.eventNumbers.insert(sample.eventNumber)
            return .duplicateDown
        }
        pending = Press(down: sample, eventNumbers: [sample.eventNumber])
        return .awaitingRelease
    }

    mutating func drag(_ sample: PointerSample) -> Reason {
        guard let down = pending?.down, sample.timestamp >= down.timestamp,
              sample.squaredDistance(to: down) > Self.maxDistanceSquared else { return .dragObserved }
        self = RecordingPointer()
        return .dragSkipped
    }

    mutating func release(_ sample: PointerSample) -> (reason: Reason, down: PointerSample?) {
        guard let pending, pending.eventNumbers.contains(sample.eventNumber),
              sample.timestamp >= pending.down.timestamp else { return (.unmatchedUp, nil) }
        if drag(sample) == .dragSkipped { return (.dragSkipped, pending.down) }
        self.pending = nil
        return (.accepted, pending.down)
    }
}
