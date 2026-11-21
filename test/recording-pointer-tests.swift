import Foundation

@main
struct RecordingPointerTests {
    static func main() throws {
        let target = 1234
        func click(_ phase: PointerObservation.Phase = .recording, down: Bool = true,
                   overlay: Bool = false, hit: Int? = 1234,
                   targetAppFrontmost: Bool = true, frontWindow: Int? = nil) -> PointerObservation {
            PointerObservation(phase: phase, down: down, plainLeftClick: down, recorderEvent: false,
                               overIndicator: overlay, hitWindow: hit, targetWindow: target,
                               targetAppFrontmost: targetAppFrontmost, frontWindow: frontWindow, atLimit: false)
        }

        let cases: [(PointerObservation, PointerObservation.Scope, PointerObservation.Reason)] = [
            (click(.preparing), .content, .beforeReady),
            (click(targetAppFrontmost: false), .activation, .accepted),
            (click(down: false), .content, .mouseUp),
            (click(frontWindow: 5678), .activation, .accepted),
            (click(), .content, .accepted),
            (click(overlay: true), .overlay, .overlay),
            (click(hit: 5678), .otherWindow, .otherWindow),
            (click(hit: nil), .unresolved, .noWindow),
        ]
        let emitTrace = CommandLine.arguments.contains("--emit-trace")
        if emitTrace { print("{\"source\":\"offline_fixture\",\"liveCapture\":false}") }
        for (index, (sample, scope, reason)) in cases.enumerated() {
            precondition(sample.scope == scope && sample.reason == reason, "Unexpected pointer classification at \(index)")
            let eventNumber = index == 2 ? 101 : Int64(100 + index)
            let timestamp = String(10_000 + index * 100)
            let row = sample.trace(
                id: "\(timestamp):\(eventNumber)", timestampNs: timestamp,
                seenAtMs: 1_700_000_000_000 + index, point: [135, 165], eventNumber: eventNumber,
                button: 0, clickCount: 1, modifierFlags: 0, quartzWindow: Int64(sample.hitWindow ?? 0)
            )
            precondition(row["reason"] as? String == reason.rawValue)
            precondition(row["eventNumber"] as? Int64 == eventNumber)
            if emitTrace {
                let line = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                print(String(decoding: line, as: UTF8.self))
            }
        }
        if !emitTrace { print("Recording pointer: \(cases.count)/\(cases.count) passed") }
    }
}
