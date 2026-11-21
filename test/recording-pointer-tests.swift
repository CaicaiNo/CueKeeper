import Foundation

@main
struct RecordingPointerTests {
    static func main() throws {
        let target = 1234
        func click(_ phase: PointerObservation.Phase = .recording, event: PointerObservation.Event = .down,
                   overlay: Bool = false, hit: Int? = 1234, button: Int64 = 0,
                   targetAppFrontmost: Bool = true, frontWindow: Int? = nil) -> PointerObservation {
            PointerObservation(phase: phase, event: event, plainClick: event == .down, recorderEvent: false,
                               overIndicator: overlay, hitWindow: hit, targetWindow: target,
                               targetAppFrontmost: targetAppFrontmost, frontWindow: frontWindow, button: button)
        }

        let cases: [(PointerObservation, PointerObservation.Scope, PointerObservation.Reason)] = [
            (click(.preparing), .content, .beforeReady),
            (click(targetAppFrontmost: false), .activation, .awaitingRelease),
            (click(event: .up), .content, .unmatchedUp),
            (click(frontWindow: 5678), .activation, .awaitingRelease),
            (click(), .content, .awaitingRelease),
            (click(button: 1), .content, .awaitingRelease),
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
                      _ clickNumbers: [Int64], counts: [Int64] = [])
            -> (name: String, inputs: [Input], reasons: [Reason], clickNumbers: [Int64],
                counts: [Int64]) {
            (name, inputs, reasons, clickNumbers,
             counts.isEmpty ? clickNumbers.map { _ in 1 } : counts)
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
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted], [1, 2], counts: [1, 2]),
            scenario("triple click", [input(.down, 0, 1), input(.up, 10, 1),
                              input(.down, 140, 2, state: 2), input(.up, 150, 2, state: 2),
                              input(.down, 280, 3, state: 3), input(.up, 290, 3, state: 3)],
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted, .awaitingRelease, .accepted],
             [1, 2, 3], counts: [1, 2, 3]),
            scenario("four fast clicks clamp to a triple click",
             [input(.down, 0, 1), input(.up, 10, 1),
              input(.down, 140, 2, state: 2), input(.up, 150, 2, state: 2),
              input(.down, 280, 3, state: 3), input(.up, 290, 3, state: 3),
              input(.down, 420, 4, state: 4), input(.up, 430, 4, state: 4)],
             [.awaitingRelease, .accepted, .awaitingRelease, .accepted, .awaitingRelease, .accepted,
              .awaitingRelease, .accepted], [1, 2, 3, 4], counts: [1, 2, 3, 3]),
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
             [.awaitingRelease, .dragStarted, .dragging, .dragAccepted], []),
            scenario("release away from origin without a dragged event",
                     [input(.down, 0, 1), input(.up, 10, 1, x: 155)],
             [.awaitingRelease, .dragAccepted], []),
            scenario("up must belong to the press", [input(.up, 0, 1), input(.down, 10, 2),
                                             input(.up, 20, 1), input(.up, 30, 2)],
             [.unmatchedUp, .awaitingRelease, .unmatchedUp, .accepted], [2]),
        ]
        for scenario in cases {
            var pointer = RecordingPointer()
            var reasons: [Reason] = []
            var clicks: [RecordingPointer.Click] = []
            var drags: [RecordingPointer.Drag] = []
            for input in scenario.inputs {
                let reason: Reason
                let click: RecordingPointer.Click?
                let drag: RecordingPointer.Drag?
                switch input.event {
                case .down:
                    reason = pointer.press(input.sample, button: 0, modifiers: [])
                    click = nil
                    drag = nil
                case .up: (reason, click, drag) = pointer.release(input.sample)
                case .drag: (reason, click, drag) = (pointer.drag(input.sample, modifiers: []), nil, nil)
                }
                reasons.append(reason)
                if reason == .accepted, let click { clicks.append(click) }
                if reason == .dragAccepted, let drag { drags.append(drag) }
                let observation = PointerObservation(
                    phase: .recording, event: input.event, plainClick: input.event == .down,
                    recorderEvent: false, overIndicator: false, hitWindow: 1234, targetWindow: 1234,
                    targetAppFrontmost: true, frontWindow: 1234, button: 0
                )
                let row = observation.trace(sample: input.sample, reason: reason, down: click?.down,
                                            seenAtMs: 1_700_000_000_000, button: 0, modifierFlags: 0, quartzWindow: 1234)
                precondition(row["reason"] as? String == reason.rawValue)
                precondition(row["clickState"] as? Int64 == input.sample.clickState)
                precondition(row["eventNumber"] as? Int64 == input.sample.eventNumber)
                precondition(row["suppressed"] as? Bool == (reason == .duplicateDown))
                precondition(row["downId"] as? String == click?.down.traceId)
                if emitTrace {
                    let line = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
                    print(String(decoding: line, as: UTF8.self))
                }
            }
            precondition(reasons == scenario.reasons, "Unexpected decisions for \(scenario.name): \(reasons)")
            let expectedDowns = scenario.inputs.filter { $0.event == .down && scenario.clickNumbers.contains($0.sample.eventNumber) }
            precondition(clicks.map(\.down.eventNumber) == scenario.clickNumbers, "Unexpected clicks for \(scenario.name)")
            precondition(zip(clicks, expectedDowns).allSatisfy { $0.down.squaredDistance(to: $1.sample) == 0 },
                         "Click moved from its press location")
            precondition(clicks.map(\.count) == scenario.counts, "Unexpected click counts for \(scenario.name)")
            let expectedDrags = scenario.reasons.filter { $0 == .dragAccepted }.count
            precondition(drags.count == expectedDrags, "Unexpected drags for \(scenario.name)")
        }
        return cases.count + testDrags()
    }

    /// Drag sampling, endpoints and duration are asserted directly: a wrong
    /// path or duration would replay a different gesture than the recorded one.
    private static func testDrags() -> Int {
        func sample(_ ms: UInt64, _ x: CGFloat, _ number: Int64 = 1) -> PointerSample {
            PointerSample(timestamp: ms * 1_000_000, location: CGPoint(x: x, y: 165),
                          eventNumber: number, clickState: 1)
        }

        // A movement below the 3 pt threshold stays a click.
        var below = RecordingPointer()
        precondition(below.press(sample(0, 135), button: 0) == .awaitingRelease)
        precondition(below.drag(sample(10, 137), modifiers: []) == .dragObserved)
        let (belowReason, belowClick, belowDrag) = below.release(sample(20, 137))
        precondition(belowReason == .accepted && belowClick != nil && belowDrag == nil)

        // Distance and time sampling: 4 px in 5 ms is not a sample, 10 px is, and
        // a 20 ms pause at the same place is. Endpoints never enter the path.
        var pointer = RecordingPointer()
        precondition(pointer.press(sample(0, 135), button: 0) == .awaitingRelease)
        precondition(pointer.drag(sample(5, 139), modifiers: []) == .dragStarted)
        precondition(pointer.drag(sample(20, 145), modifiers: []) == .dragging)
        precondition(pointer.drag(sample(25, 147), modifiers: []) == .dragging)
        let (reason, click, drag) = pointer.release(sample(40, 150))
        precondition(reason == .dragAccepted && click == nil)
        guard let drag else { preconditionFailure("A drag must produce a drag record") }
        precondition(drag.from.location.x == 135, "Drag must keep its press origin")
        precondition(drag.to.location.x == 150, "Drag must keep its release point")
        precondition(drag.path.map(\.location.x) == [145], "Unexpected sampled path \(drag.path.map(\.location.x))")
        precondition(drag.durationMs == 40, "Unexpected drag duration \(drag.durationMs)")
        precondition(drag.button == 0)

        // A modifier drag keeps the modifiers so the CLI can refuse to replay it
        // instead of silently turning a copy-drag into a move-drag.
        var modified = RecordingPointer()
        precondition(modified.press(sample(0, 135), button: 0, modifiers: ["alt"]) == .awaitingRelease)
        precondition(modified.drag(sample(10, 160), modifiers: []) == .dragStarted)
        let (modifiedReason, _, modifiedDrag) = modified.release(sample(20, 160))
        precondition(modifiedReason == .dragAccepted && modifiedDrag?.modifiers == ["alt"])

        // The path is capped instead of growing without bound.
        var long = RecordingPointer()
        precondition(long.press(sample(0, 135), button: 0) == .awaitingRelease)
        for index in 1...80 {
            _ = long.drag(sample(UInt64(index * 20), 135 + CGFloat(index * 10)), modifiers: [])
        }
        let (longReason, _, longDrag) = long.release(sample(1700, 935))
        precondition(longReason == .dragAccepted && longDrag?.path.count == 64)
        return 3
    }
}
