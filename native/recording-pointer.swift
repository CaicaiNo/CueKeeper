struct PointerObservation {
    enum Phase: String { case preparing, recording, paused, stopping }
    enum Scope: String { case activation, content, overlay, otherWindow = "other_window", unresolved }
    enum Reason: String {
        case beforeReady = "before_ready", paused, stopping
        case recorderEvent = "recorder_event", overlay, otherWindow = "other_window", noWindow = "no_window"
        case unsupportedClick = "unsupported_click", eventLimit = "event_limit", mouseUp = "mouse_up_only", accepted
    }

    let phase: Phase
    let down: Bool
    let plainLeftClick: Bool
    let recorderEvent: Bool
    let overIndicator: Bool
    let hitWindow: Int?
    let targetWindow: Int
    let targetAppFrontmost: Bool?
    let frontWindow: Int?
    let atLimit: Bool

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
        switch scope {
        case .overlay: return .overlay
        case .otherWindow: return .otherWindow
        case .unresolved: return .noWindow
        case .activation, .content: break
        }
        guard down else { return .mouseUp }
        guard plainLeftClick else { return .unsupportedClick }
        return atLimit ? .eventLimit : .accepted
    }

    func trace(id: String, timestampNs: String, seenAtMs: Int, point: [Double], eventNumber: Int64,
               button: Int64, clickCount: Int64, modifierFlags: UInt64, quartzWindow: Int64) -> [String: Any] {
        let result = reason
        let decision = result == .accepted ? "accepted" : result == .mouseUp ? "observed" : "filtered"
        var row: [String: Any] = [
            "kind": "click_trace", "stage": "native", "event": down ? "down" : "up",
            "id": id, "timestampNs": timestampNs, "seenAtMs": seenAtMs, "point": point,
            "eventNumber": eventNumber, "button": button, "clickCount": clickCount, "modifierFlags": modifierFlags,
            "quartzWindow": quartzWindow, "targetWindow": targetWindow, "phase": phase.rawValue,
            "scope": scope.rawValue, "decision": decision, "reason": result.rawValue,
        ]
        row["hitWindow"] = hitWindow
        row["targetAppFrontmost"] = targetAppFrontmost
        row["frontWindow"] = frontWindow
        return row
    }
}
