import Foundation

@main
struct RecordingPointerTests {
    static func main() throws {
        let target = 1234
        func click(_ phase: PointerObservation.Phase = .recording, event: PointerObservation.Event = .down,
                   overlay: Bool = false, hit: Int? = 1234,
                   targetAppFrontmost: Bool = true, frontWindow: Int? = nil) -> PointerObservation {
            PointerObservation(phase: phase, event: event, plainLeftClick: event == .down, recorderEvent: false,
                               overIndicator: overlay, hitWindow: hit, targetWindow: target,
                               targetAppFrontmost: targetAppFrontmost, frontWindow: frontWindow)
        }

        let cases: [(PointerObservation, PointerObservation.Scope, PointerObservation.Reason)] = [
            (click(.preparing), .content, .beforeReady),
            (click(targetAppFrontmost: false), .activation, .awaitingRelease),
            (click(event: .up), .content, .unmatchedUp),
            (click(frontWindow: 5678), .activation, .awaitingRelease),
            (click(), .content, .awaitingRelease),
            (click(overlay: true), .overlay, .overlay),
            (click(hit: 5678), .otherWindow, .otherWindow),
            (click(hit: nil), .unresolved, .noWindow),
        ]
        let emitTrace = CommandLine.arguments.contains("--emit-trace")
        if emitTrace { print("{\"source\":\"offline_fixture\",\"liveCapture\":false}") }
        for (index, (sample, scope, reason)) in cases.enumerated() {
            precondition(sample.scope == scope && sample.reason == reason, "Unexpected pointer classification at \(index)")
            let eventNumber = index == 2 ? 101 : Int64(100 + index)
            let pointerSample = PointerSample(timestamp: UInt64(10_000 + index * 100), location: CGPoint(x: 135, y: 165),
                                              eventNumber: eventNumber, clickState: 1)
            let row = sample.trace(
                sample: pointerSample, reason: reason, seenAtMs: 1_700_000_000_000 + index,
                button: 0, modifierFlags: 0, quartzWindow: Int64(sample.hitWindow ?? 0)
            )
            precondition(row["reason"] as? String == reason.rawValue)
            precondition(row["eventNumber"] as? Int64 == eventNumber)
            if emitTrace {
                let line = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                print(String(decoding: line, as: UTF8.self))
            }
        }
        let count = cases.count + (try testSequences(emitTrace: emitTrace))
        if !emitTrace { print("Recording pointer: \(count)/\(count) passed") }
    }

    private static func testSequences(emitTrace: Bool) throws -> Int {
        typealias Event = PointerObservation.Event
        typealias Reason = PointerObservation.Reason
        typealias Input = (event: Event, sample: PointerSample)

        func input(_ event: Event, _ ms: UInt64, _ number: Int64, x: CGFloat = 135, state: Int64 = 1) -> Input {
            (event, PointerSample(timestamp: ms * 1_000_000, location: CGPoint(x: x, y: 165),
                                  eventNumber: number, clickState: state))
        }

        func scenario(_ name: String, _ inputs: [Input], _ reasons: [Reason],
                      _ clickNumbers: [Int64], _ warnings: [String] = [])
            -> (name: String, inputs: [Input], reasons: [Reason], clickNumbers: [Int64], warnings: [String]) {
            (name, inputs, reasons, clickNumbers, warnings)
        }
        let burst = (0..<5).map { input(.down, UInt64($0 * 10), Int64($0 + 1)) }
        let pairedBurst: [Input] = burst.flatMap { down -> [Input] in
            let releaseMs = down.sample.timestamp / 1_000_000 + 4
            return [down, input(.up, releaseMs, down.sample.eventNumber)]
        }
        let repeatedPair: [Reason] = [.duplicateDown, .unmatchedUp]
        let cases = [
            scenario("single click", [input(.down, 0, 1), input(.up, 10, 1, x: 136)],
             [.awaitingRelease, .accepted], [1]),
            scenario("five overlapping downs", burst + [input(.up, 50, 5), input(.up, 51, 1)],
             [.awaitingRelease, .duplicateDown, .duplicateDown, .duplicateDown, .duplicateDown, .accepted, .unmatchedUp],
             [1]),
            scenario("five complete pairs in a burst", pairedBurst,
             [.awaitingRelease, .accepted] + repeatedPair + repeatedPair + repeatedPair + repeatedPair,
             [1]),
            scenario("double click", [input(.down, 0, 1), input(.up, 10, 1),
                              input(.down, 140, 2, state: 2), input(.up, 150, 2, state: 2)],
             [.awaitingRelease, .accepted, .multiClickCollapsed, .unmatchedUp], [1], ["MULTI_CLICK_COLLAPSED"]),
            scenario("two independent clicks 300 ms apart", [input(.down, 0, 1), input(.up, 10, 1),
                                                      input(.down, 300, 2), input(.up, 310, 2)],
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted], [1, 2]),
            scenario("three fast clicks at distinct positions", [input(.down, 0, 1), input(.up, 10, 1),
                                                         input(.down, 20, 2, x: 138), input(.up, 30, 2, x: 138),
                                                         input(.down, 40, 3, x: 141), input(.up, 50, 3, x: 141)],
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted, .awaitingRelease, .accepted], [1, 2, 3]),
            scenario("exactly 120 ms and 3 px thresholds", [input(.down, 0, 1), input(.up, 10, 1, x: 138),
                                                     input(.down, 120, 2), input(.up, 130, 2)],
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted], [1, 2]),
            scenario("drag returns to origin", [input(.down, 0, 1), input(.drag, 10, 1, x: 155),
                                         input(.drag, 20, 1), input(.up, 30, 1)],
             [.awaitingRelease, .dragSkipped, .dragObserved, .unmatchedUp], [], ["DRAG_SKIPPED"]),
            scenario("release away from origin", [input(.down, 0, 1), input(.up, 10, 1, x: 155)],
             [.awaitingRelease, .dragSkipped], [], ["DRAG_SKIPPED"]),
            scenario("up must belong to the press", [input(.up, 0, 1), input(.down, 10, 2),
                                             input(.up, 20, 1), input(.up, 30, 2)],
             [.unmatchedUp, .awaitingRelease, .unmatchedUp, .accepted], [2]),
        ]
        for scenario in cases {
            var pointer = RecordingPointer()
            var reasons: [Reason] = []
            var clicks: [PointerSample] = []
            for input in scenario.inputs {
                let reason: Reason
                let down: PointerSample?
                switch input.event {
                case .down: (reason, down) = (pointer.press(input.sample), nil)
                case .up: (reason, down) = pointer.release(input.sample)
                case .drag: (reason, down) = (pointer.drag(input.sample), nil)
                }
                reasons.append(reason)
                if reason == .accepted, let down { clicks.append(down) }
                let observation = PointerObservation(
                    phase: .recording, event: input.event, plainLeftClick: input.event == .down,
                    recorderEvent: false, overIndicator: false, hitWindow: 1234, targetWindow: 1234,
                    targetAppFrontmost: true, frontWindow: 1234
                )
                let row = observation.trace(sample: input.sample, reason: reason, down: down,
                                            seenAtMs: 1_700_000_000_000, button: 0, modifierFlags: 0, quartzWindow: 1234)
                precondition(row["reason"] as? String == reason.rawValue)
                precondition(row["clickState"] as? Int64 == input.sample.clickState)
                precondition(row["eventNumber"] as? Int64 == input.sample.eventNumber)
                precondition(row["suppressed"] as? Bool == [.duplicateDown, .multiClickCollapsed, .dragSkipped].contains(reason))
                precondition(row["downId"] as? String == down?.traceId)
                if emitTrace {
                    let line = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                    print(String(decoding: line, as: UTF8.self))
                }
            }
            precondition(reasons == scenario.reasons, "Unexpected decisions for \(scenario.name): \(reasons)")
            let expectedDowns = scenario.inputs.filter { $0.event == .down && scenario.clickNumbers.contains($0.sample.eventNumber) }
            precondition(clicks.map(\.eventNumber) == scenario.clickNumbers, "Unexpected clicks for \(scenario.name)")
            precondition(zip(clicks, expectedDowns).allSatisfy { $0.squaredDistance(to: $1.sample) == 0 },
                         "Click moved from its press location")
            precondition(reasons.compactMap(\.warning) == scenario.warnings, "Unexpected warnings for \(scenario.name)")
        }
        return cases.count
    }
}
