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
        let count = cases.count + (try testSequences(emitTrace: emitTrace)) + testHover() + testHoverEmission()
            + testGlobalClickEvidence() + testPointerIdentity() + testFileItemIdentity()
            + testTapGuard() + testTapCallbackPath() + testFocusVerdict()
        if !emitTrace { print("Recording pointer: \(count)/\(count) passed") }
    }

    /// One deadline bounds the callback's work; the two facts it reports are
    /// told apart; a run of unclassifiable input becomes one gap; and the output
    /// writer keeps the order the callback produced.
    private static func testTapGuard() -> Int {
        let ms: (UInt64) -> UInt64 = { $0 * 1_000_000 }
        var guardRail = TapGuard()

        // Work outside a callback gets the ceiling and is never cut short.
        precondition(guardRail.readTimeout(now: ms(0)) == TapGuard.readCeilingSeconds)

        // A normal callback: measured, never an interruption, never refused.
        guardRail.begin("hover", now: ms(1_000))
        precondition(guardRail.readTimeout(now: ms(1_012)) == TapGuard.readCeilingSeconds)
        precondition(guardRail.end(now: ms(1_012)) == 12)
        precondition(guardRail.callbackMs < TapGuard.slowCallbackMs)
        precondition(guardRail.interruptions == 0)

        // The deadline is handed out as the remainder: a read that starts near it
        // blocks for what is left, not for the whole ceiling.
        guardRail.begin("pointer", now: ms(2_000))
        if let timeout = guardRail.readTimeout(now: ms(2_250)) {
            precondition(abs(timeout - 0.05) < 0.0001)
        } else {
            preconditionFailure("Half the budget was left")
        }
        if let timeout = guardRail.readTimeout(now: ms(2_299)) {
            precondition(timeout <= 0.0011 && timeout > 0)
        } else {
            preconditionFailure("One millisecond was left")
        }
        // No read may start once the budget is gone.
        precondition(guardRail.readTimeout(now: ms(2_300)) == nil)
        precondition(guardRail.readTimeout(now: ms(2_900)) == nil)
        let slow = guardRail.end(now: ms(2_640))
        precondition(slow == 640)
        precondition(slow >= TapGuard.slowCallbackMs)
        precondition(guardRail.noteSlowCallback() == 1)
        precondition(guardRail.interruptions == 0)

        // The disable notification is itself a callback, so the diagnostic has to
        // name the callback before it, not the notification.
        guardRail.begin("event", now: ms(3_000))
        let first = guardRail.interrupted(reason: "timeout")
        precondition(first.count == 1)
        precondition(first.lastCallbackMs == 640)
        precondition(first.lastOperation == "pointer")
        precondition(first.reason == "timeout")
        _ = guardRail.end(now: ms(3_001))

        // Recovering and then doing normal work adds no interruption.
        guardRail.begin("hover", now: ms(4_000))
        precondition(guardRail.readTimeout(now: ms(4_020)) == TapGuard.readCeilingSeconds)
        precondition(guardRail.end(now: ms(4_020)) == 20)
        precondition(guardRail.callbackMs < TapGuard.slowCallbackMs)
        precondition(guardRail.interruptions == 1)

        // A run of unclassifiable presses reports one gap, not one per press.
        var unverifiable = UnverifiableText()
        precondition(unverifiable.dropped())
        precondition(!unverifiable.dropped())
        precondition(!unverifiable.dropped())
        precondition(unverifiable.isOpen)
        unverifiable.verified()
        precondition(unverifiable.dropped())
        return 19
    }

    /// Content is only recorded when the control was read and is not protected;
    /// a timed-out role is "unknown", never "safe".
    private static func testFocusVerdict() -> Int {
        // The read that timed out (the budget was spent) cannot vouch for safety.
        let timedOut = FocusVerdict.read(role: nil, roleFailed: true,
                                         subrole: nil, subroleFailed: true)
        precondition(!timedOut.classified)
        precondition(timedOut.text == .unknown)
        // A role that was read but names no secure input, with the subrole read
        // still missing, is also unknown: the subrole could be the secure one.
        let halfRead = FocusVerdict.read(role: "AXTextField", roleFailed: false,
                                         subrole: nil, subroleFailed: true)
        precondition(!halfRead.classified)
        precondition(halfRead.text == .unknown)
        // An element without a role at all is not something to type into.
        precondition(FocusVerdict.read(role: nil, roleFailed: false,
                                       subrole: nil, subroleFailed: false).text == .unknown)
        precondition(FocusVerdict.read(role: "", roleFailed: false,
                                       subrole: nil, subroleFailed: false).text == .unknown)
        // Both attributes answered: the ordinary field may receive text.
        let field = FocusVerdict.read(role: "AXTextField", roleFailed: false,
                                      subrole: nil, subroleFailed: false)
        precondition(field.classified && !field.secure)
        precondition(field.text == .record)
        // A protected control is a checkpoint even before the system-wide flag is
        // set, by role or by subrole.
        let secureRole = FocusVerdict.read(role: "AXSecureTextField", roleFailed: false,
                                           subrole: nil, subroleFailed: false)
        precondition(secureRole.text == .secure)
        let secureSubrole = FocusVerdict.read(role: "AXTextField", roleFailed: false,
                                              subrole: "AXSecureTextField", subroleFailed: false)
        precondition(secureSubrole.text == .secure)
        // A secure role decides even when the subrole read failed.
        let secureOnly = FocusVerdict.read(role: "AXSecureTextField", roleFailed: false,
                                           subrole: nil, subroleFailed: true)
        precondition(secureOnly.text == .secure)
        return 12
    }

    /// The callback and recovery path end to end, with a clock the slow work
    /// advances: reads stop at the deadline, the events keep their order, and a
    /// real disable still produces a blocking gap.
    private static func testTapCallbackPath() -> Int {
        final class Box { var now: UInt64 = 0; var lines: [String] = []; let lock = NSLock() }
        let box = Box()
        let writer = LineWriter { data in
            box.lock.lock()
            box.lines.append(String(decoding: data, as: UTF8.self).trimmingCharacters(in: .newlines))
            box.lock.unlock()
        }
        var guardRail = TapGuard()
        let clock: () -> UInt64 = { box.now }
        let advance: (UInt64) -> Void = { box.now += $0 * 1_000_000 }

        // A whole callback, the way the recorder runs it: work asks the guard for
        // time, and the guard hands out what is left.
        func callback(_ operation: String, _ work: () -> Void) -> Int {
            guardRail.begin(operation, now: clock())
            work()
            let spent = guardRail.end(now: clock())
            if spent >= TapGuard.slowCallbackMs {
                writer.append(Data("TAP_SLOW_CALLBACK:\(operation):\(spent)\n".utf8))
            }
            return spent
        }

        // 1. A normal event.
        _ = callback("hover") {
            precondition(guardRail.readTimeout(now: clock()) != nil)
            advance(12)
            writer.append(Data("event:hover1\n".utf8))
        }

        // 2. A slow accessibility read: it keeps starting reads until the guard
        //    refuses, so the work — not just the check — is bounded.
        var reads = 0
        _ = callback("pointer") {
            while guardRail.readTimeout(now: clock()) != nil {
                reads += 1
                advance(40)
            }
            writer.append(Data("event:click2\n".utf8))
        }
        // Eight reads of 40 ms fit the 300 ms budget; the ninth would start past
        // it, and the guard refuses it while the callback is still running.
        precondition(reads == 8, "reads must stop at the 300 ms deadline, saw \(reads)")

        // 3. The system disabled the tap: the gap is what blocks replay, and the
        //    callback after it keeps delivering.
        guardRail.begin("event", now: clock())
        let notice = guardRail.interrupted(reason: "timeout")
        precondition(notice.count == 1)
        precondition(notice.lastOperation == "pointer")
        writer.append(Data("gap:tap_interrupted\n".utf8))
        _ = guardRail.end(now: clock())

        // 4. Recovered: two more events, in order.
        for index in 3...4 {
            _ = callback("key") {
                precondition(guardRail.readTimeout(now: clock()) != nil)
                advance(8)
                writer.append(Data("event:key\(index)\n".utf8))
            }
        }

        writer.flush()
        box.lock.lock()
        let lines = box.lines
        box.lock.unlock()
        // The slow callback's warning follows the line its work produced, exactly
        // as the recorder emits it, and nothing after the interruption is lost or
        // reordered.
        precondition(lines == [
            "event:hover1", "event:click2", "TAP_SLOW_CALLBACK:pointer:320",
            "gap:tap_interrupted", "event:key3", "event:key4",
        ], "unexpected output order: \(lines)")
        return 6
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

    private static func testGlobalClickEvidence() -> Int {
        let finderPID: Int32 = 198
        let finderWindow = 1234
        let finder: [String: Any] = [
            "app": "com.apple.finder", "pid": Int(finderPID), "windowNumber": finderWindow,
            "windowTitle": "Downloads", "role": "AXRow", "name": "Example.pkg", "pressable": true,
        ]
        let finderTarget = GlobalPointerTarget(eventWindow: finderWindow, liveWindow: finderWindow,
                                               destination: finderPID, predatesFocus: false)
        precondition(finderTarget.canReadAX)
        let finderEvidence = GlobalPointerEvidence(owner: finder, focusGeneration: 3, secureEvidence: [],
                                                    targetMatches: finderTarget.matches(ownerPID: finderPID),
                                                    isFocused: true, axOwnerMatches: true)
        let start: UInt64 = 10_000_000_000
        var lag = GlobalCaptureLag()
        func click(_ pointer: inout RecordingPointer, at ms: UInt64, seen: Int, number: Int64 = 1,
                   count: Int64 = 1, button: Int64 = 0, evidence: GlobalPointerEvidence) -> [String: Any] {
            let point = CGPoint(x: 135, y: 165)
            let down = PointerSample(timestamp: start + ms * 1_000_000, location: point,
                                     eventNumber: number, clickState: count)
            let up = PointerSample(timestamp: down.timestamp + 10_000_000, location: point,
                                   eventNumber: number, clickState: count)
            let observedAt = start + UInt64(seen) * 1_000_000
            precondition(!lag.shouldReport(isKeyDown: false, timestamp: down.timestamp, now: observedAt))
            precondition(!lag.shouldReport(isKeyDown: false, timestamp: up.timestamp, now: observedAt))
            precondition(pointer.press(down, button: button) == .awaitingRelease)
            let (reason, click, _) = pointer.release(up)
            guard reason == .accepted, let click, let t = click.elapsedMilliseconds(since: start) else {
                preconditionFailure("Expected the press and release to make a click")
            }
            return click.payload(t: t, seen: seen, evidence: evidence)
        }

        // A callback processed 1.9 s after the click keeps its complete owner and input evidence.
        var pointer = RecordingPointer()
        let delayed = click(&pointer, at: 100, seen: 2_000, evidence: finderEvidence)
        precondition(delayed["kind"] as? String == "click" && delayed["decision"] as? String == "record")
        precondition(delayed["gapCode"] == nil && delayed["point"] as? [Int] == [135, 165])
        precondition(delayed["button"] as? String == "left" && delayed["count"] as? Int == 1)
        precondition((delayed["owner"] as? NSDictionary)?.isEqual(to: finder) == true)

        // The second click arrives after the live hit changed. Quartz still
        // names Finder, so the point survives without taking another window's AX data.
        let queuedTarget = GlobalPointerTarget(eventWindow: finderWindow, liveWindow: 5678,
                                               destination: finderPID, predatesFocus: false)
        precondition(queuedTarget.window == finderWindow && !queuedTarget.canReadAX)
        var pointOwner = finder
        pointOwner["role"] = nil
        pointOwner["name"] = nil
        pointOwner["pressable"] = false
        let pointEvidence = GlobalPointerEvidence(owner: pointOwner, focusGeneration: 3, secureEvidence: [],
                                                   targetMatches: queuedTarget.matches(ownerPID: finderPID),
                                                   isFocused: true, axOwnerMatches: nil)
        let second = click(&pointer, at: 240, seen: 3_100, number: 2, count: 2, evidence: pointEvidence)
        let doubleClick = [delayed, second]
        precondition(doubleClick.map { $0["t"] as? Int } == [100, 240])
        precondition(doubleClick.map { $0["count"] as? Int } == [1, 2])
        precondition(doubleClick.allSatisfy { $0["decision"] as? String == "record" && $0["gapCode"] == nil })
        precondition((second["owner"] as? NSDictionary)?.isEqual(to: pointOwner) == true)

        // With no event window and a newer focus observation, the live hit
        // cannot identify the original click. The gap keeps its coordinates.
        let missing = GlobalPointerTarget(eventWindow: nil, liveWindow: 5678, destination: nil, predatesFocus: true)
        precondition(missing.window == nil)
        let missingEvidence = GlobalPointerEvidence(owner: ["pressable": false], focusGeneration: 4, secureEvidence: [],
                                                     targetMatches: missing.matches(ownerPID: finderPID),
                                                     isFocused: false, axOwnerMatches: nil)
        let gap = click(&pointer, at: 400, seen: 3_800, number: 3, button: 1, evidence: missingEvidence)
        precondition(gap["kind"] as? String == "click" && gap["decision"] as? String == "gap")
        precondition(gap["gapCode"] as? String == "CAPTURE_SCOPE_UNVERIFIED")
        precondition(gap["point"] as? [Int] == [135, 165] && gap["button"] as? String == "right")
        let missingOwner = gap["owner"] as? [String: Any]
        precondition(gap["count"] as? Int == 1 && missingOwner?["app"] == nil)
        precondition(missingOwner?["pid"] == nil && missingOwner?["windowNumber"] == nil)

        let conflicting = GlobalPointerTarget(eventWindow: finderWindow, liveWindow: finderWindow,
                                                destination: 23, predatesFocus: false)
        let conflictingEvidence = GlobalPointerEvidence(owner: finder, focusGeneration: 3, secureEvidence: [],
                                                         targetMatches: conflicting.matches(ownerPID: finderPID),
                                                         isFocused: true, axOwnerMatches: nil)
        precondition(conflictingEvidence.fields(forClick: true)["gapCode"] as? String == "CAPTURE_SCOPE_UNVERIFIED")
        let conflictingAX = GlobalPointerEvidence(owner: finder, focusGeneration: 3, secureEvidence: [],
                                                   targetMatches: true, isFocused: true, axOwnerMatches: false)
        precondition(conflictingAX.fields(forClick: true)["gapCode"] as? String == "CAPTURE_SCOPE_UNVERIFIED")

        let secure = GlobalPointerEvidence(owner: pointOwner, focusGeneration: 3,
                                            secureEvidence: ["system_secure_input"], targetMatches: true,
                                            isFocused: true, axOwnerMatches: nil)
        precondition(secure.fields(forClick: true)["gapCode"] as? String == "SECURE_INPUT")

        // A context menu is its own window owned by the app, so the menu is
        // never the focused window. The item the user pressed is still a proven
        // action: it names the step and keeps the window that opened the menu.
        let menuItem: [String: Any] = [
            "app": "com.apple.finder", "pid": Int(finderPID), "windowNumber": finderWindow,
            "windowTitle": "Downloads", "role": "AXMenuItem", "name": "重命名", "pressable": true,
        ]
        var menuEvidence = GlobalPointerEvidence(owner: menuItem, focusGeneration: 3, secureEvidence: [],
                                                  targetMatches: true, isFocused: false, axOwnerMatches: true)
        menuEvidence.menuAction = true
        let menuFields = menuEvidence.fields(forClick: true)
        precondition(menuFields["decision"] as? String == "record", "a menu item press became a gap")
        precondition(menuFields["gapCode"] == nil)
        // The same unfocused item without menu proof is not a press the recorder
        // can attribute; only the menu path earns the record.
        let unfocusedItem = GlobalPointerEvidence(owner: menuItem, focusGeneration: 3, secureEvidence: [],
                                                   targetMatches: true, isFocused: false, axOwnerMatches: true)
        precondition(unfocusedItem.fields(forClick: true)["gapCode"] as? String == "CAPTURE_SCOPE_UNVERIFIED")

        precondition(lag.shouldReport(isKeyDown: true, timestamp: start, now: start + 4_000_000_000))
        precondition(!lag.shouldReport(isKeyDown: true, timestamp: start, now: start + 4_100_000_000))
        return 9
    }

    /// Finder names the clicked file, not the anonymous field under the
    /// pointer: a role alone would make a replay hit any look-alike.
    private static func testPointerIdentity() -> Int {
        let image = PointerElement(role: "AXImage", name: "manifest.json")
        precondition(PointerIdentityResolver.resolve(hit: image, ancestors: [])
            == PointerIdentity(role: "AXImage", name: "manifest.json"))

        // The name lives on the enclosing row, which is what the click means.
        let field = PointerElement(role: "AXTextField", name: nil)
        let row = PointerElement(role: "AXRow", name: "manifest.json")
        let cell = PointerElement(role: "AXCell", name: nil)
        precondition(PointerIdentityResolver.resolve(hit: field, ancestors: [row, cell])
            == PointerIdentity(role: "AXRow", name: "manifest.json"))

        // A named static text label names the file it labels.
        let label = PointerElement(role: "AXStaticText", name: "notes.txt")
        precondition(PointerIdentityResolver.resolve(hit: label, ancestors: [cell, row])
            == PointerIdentity(role: "AXStaticText", name: "notes.txt"))

        // A wrapper never becomes the target; an unnamed chain proves no name.
        let toolbar = PointerElement(role: "AXToolbar", name: "Downloads")
        let group = PointerElement(role: "AXGroup", name: "列")
        precondition(PointerIdentityResolver.resolve(hit: field, ancestors: [group, toolbar])
            == PointerIdentity(role: "AXTextField", name: nil))
        precondition(PointerIdentityResolver.resolve(hit: PointerElement(role: nil, name: nil), ancestors: []) == nil)
        return 5
    }

    /// A list view row's own name joins its columns; only the file itself names
    /// the item, so the date/size/kind description never becomes a target.
    private static func testFileItemIdentity() -> Int {
        // AXFilename is the file's display name and wins over everything else.
        precondition(PointerFileItem.name(filename: "manifest.json", url: "index.html", column: "今天 21:36")
            == "manifest.json")
        // Without it, the file URL's last path component is the same name.
        precondition(PointerFileItem.name(filename: nil, url: "manifest.json", column: "今天 21:36")
            == "manifest.json")
        // The name column's text field is the remaining source.
        precondition(PointerFileItem.name(filename: nil, url: nil, column: "manifest.json") == "manifest.json")
        // A row that names no file stays unnamed instead of taking its columns.
        precondition(PointerFileItem.name(filename: nil, url: nil, column: nil) == nil)
        precondition(PointerFileItem.name(filename: "  ", url: "", column: "\n") == nil)
        // A value is a display name, never a document.
        precondition(PointerFileItem.name(filename: nil, url: nil, column: String(repeating: "a", count: 257)) == nil)
        // Outline rows are treeitems in every window tree, so replay finds them.
        precondition(PointerIdentityResolver.snapshotRole("AXOutlineRow") == "treeitem")
        precondition(PointerIdentityResolver.snapshotRole("AXRow") == "AXRow")
        precondition(PointerIdentityResolver.snapshotRole("AXCell") == "AXCell")
        return 9
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

    /// Hover is a settled dwell, not a single move sample. Each assertion is a
    /// real tracker sequence: a short pass, a settled dwell, a moved-away point,
    /// the latest position reported by a move and by the timer, and a reset.
    private static func testHover() -> Int {
        func ms(_ value: UInt64) -> UInt64 { value * 1_000_000 }

        // A 200 ms pass never becomes a hover, and the latest sample is kept.
        var passing = HoverTracker()
        precondition(passing.sample(location: CGPoint(x: 10, y: 10), timestamp: ms(0)) == nil)
        precondition(passing.sample(location: CGPoint(x: 11, y: 10), timestamp: ms(200)) == nil)
        precondition(passing.flush(now: ms(250)) == nil)
        precondition(passing.location?.x == 11)

        // A settled point reports once with its dwell, then stays quiet.
        var settled = HoverTracker()
        precondition(settled.sample(location: CGPoint(x: 40, y: 50), timestamp: ms(0)) == nil)
        precondition(settled.sample(location: CGPoint(x: 41, y: 50), timestamp: ms(400)) == 400)
        precondition(settled.location?.x == 41)
        precondition(settled.sample(location: CGPoint(x: 41, y: 51), timestamp: ms(900)) == nil)
        precondition(settled.flush(now: ms(1200)) == nil)
        precondition(settled.location?.y == 51)

        // A move inside the radius keeps the dwell's clock but the step reports
        // where the pointer stopped, not the sample that opened the dwell.
        var drifted = HoverTracker()
        precondition(drifted.sample(location: CGPoint(x: 40, y: 50), timestamp: ms(0)) == nil)
        precondition(drifted.sample(location: CGPoint(x: 41, y: 50), timestamp: ms(150)) == nil)
        precondition(drifted.sample(location: CGPoint(x: 42, y: 50), timestamp: ms(400)) == 400)
        precondition(drifted.location?.x == 42 && drifted.location?.y == 50)

        // The timer callback (a pointer that stopped moving) reports the last
        // position inside the radius too.
        var flushed = HoverTracker()
        precondition(flushed.sample(location: CGPoint(x: 40, y: 50), timestamp: ms(0)) == nil)
        precondition(flushed.sample(location: CGPoint(x: 41.5, y: 50), timestamp: ms(120)) == nil)
        precondition(flushed.location?.x == 41.5)
        precondition(flushed.flush(now: ms(400)) == 400)
        precondition(flushed.location?.x == 41.5)

        // Moving beyond the radius starts a new dwell anchored at the new point.
        var moved = HoverTracker()
        precondition(moved.sample(location: CGPoint(x: 10, y: 10), timestamp: ms(0)) == nil)
        precondition(moved.sample(location: CGPoint(x: 50, y: 10), timestamp: ms(500)) == nil)
        precondition(moved.location?.x == 50)
        precondition(moved.flush(now: ms(900)) == 400)

        // A reset (pause, press, other window) discards the pending dwell.
        var reset = HoverTracker()
        precondition(reset.sample(location: CGPoint(x: 10, y: 10), timestamp: ms(0)) == nil)
        reset.reset()
        precondition(reset.flush(now: ms(1000)) == nil)
        return 6
    }

    /// A hover is stored in the same Quartz space as a click (origin top-left);
    /// the AppKit flip exists only for the window hit test. The cases drive
    /// `HoverRecorder` — the type both production paths call — so the sample
    /// path and the timer flush are each asserted to hand out exactly one step,
    /// with the Quartz point in the payload and the AppKit point for the hit
    /// test. `receiveHover`/`flushHover` only add the AppKit guards and emit.
    private static func testHoverEmission() -> Int {
        func ms(_ value: UInt64) -> UInt64 { value * 1_000_000 }
        let screenHeight: CGFloat = 956
        let s7 = CGPoint(x: 604, y: 671)
        let s8 = CGPoint(x: 603, y: 634)

        // A pass shorter than the dwell never becomes a hover, by either path.
        var passing = HoverRecorder()
        precondition(passing.sample(location: s7, timestamp: ms(0), primaryScreenHeight: screenHeight) == nil)
        precondition(passing.sample(location: CGPoint(x: 606, y: 671), timestamp: ms(200),
                                    primaryScreenHeight: screenHeight) == nil)
        precondition(passing.flush(now: ms(250), primaryScreenHeight: screenHeight) == nil)

        // Sample-triggered path, the s7 hover of global-9d815eb5: the pointer
        // rested at Quartz (604, 671) on a 956 pt screen.
        var settled = HoverRecorder()
        precondition(settled.sample(location: s7, timestamp: ms(0), primaryScreenHeight: screenHeight) == nil)
        let sampled = settled.sample(location: s7, timestamp: ms(319), primaryScreenHeight: screenHeight)
        let sampledRow = sampled?.payload(t: 5699, seen: 1_700_000_000_000) ?? [:]
        precondition(sampled?.dwellMs == 319)
        precondition(sampledRow["point"] as? [Int] == [604, 671], "hover must store the Quartz point")
        precondition(sampledRow["point"] as? [Int] != [604, 285], "hover must not store the AppKit point")
        precondition(sampled?.hitPoint.x == 604 && sampled?.hitPoint.y == 285, "hit test keeps the AppKit point")
        precondition(sampledRow["dwellMs"] as? Int == 319)
        // One dwell never reports twice: neither a later sample nor the timer.
        precondition(settled.sample(location: s7, timestamp: ms(600), primaryScreenHeight: screenHeight) == nil)
        precondition(settled.flush(now: ms(700), primaryScreenHeight: screenHeight) == nil)

        // Timer flush path, the s8 hover: one sample, then the pointer stops and
        // no further sample arrives, so only the session timer can report it.
        var flushed = HoverRecorder()
        precondition(flushed.sample(location: s8, timestamp: ms(0), primaryScreenHeight: screenHeight) == nil)
        let flushedOver = flushed.flush(now: ms(405), primaryScreenHeight: screenHeight)
        let flushedRow = flushedOver?.payload(t: 6621, seen: 1_700_000_000_000) ?? [:]
        precondition(flushedOver?.dwellMs == 405)
        precondition(flushedRow["point"] as? [Int] == [603, 634])
        precondition(flushedOver?.hitPoint.x == 603 && flushedOver?.hitPoint.y == 322)
        precondition(flushed.flush(now: ms(900), primaryScreenHeight: screenHeight) == nil)

        // A pause or a press resets the pending dwell: no hover comes out of it.
        var paused = HoverRecorder()
        precondition(paused.sample(location: s7, timestamp: ms(0), primaryScreenHeight: screenHeight) == nil)
        paused.reset()
        precondition(paused.flush(now: ms(900), primaryScreenHeight: screenHeight) == nil)
        precondition(paused.sample(location: s7, timestamp: ms(950), primaryScreenHeight: screenHeight) == nil)

        // The same physical spot clicked at the same moment writes the same
        // number: a hover and a click share one coordinate space.
        let click = RecordingPointer.Click(
            down: PointerSample(timestamp: 0, location: s7, eventNumber: 1, clickState: 1),
            button: 0, count: 1, truncated: false)
        precondition(click.payload(t: 0, seen: 0)["point"] as? [Int] == sampledRow["point"] as? [Int])

        // The stored point does not depend on the screen height; the hit-test
        // point does, because AppKit measures up from the primary screen's bottom.
        precondition(sampledRow["point"] as? [Int] ==
                     HoverEmission(dwellMs: 319, screenPoint: s7, primaryScreenHeight: 1080).payloadPoint)
        let tall = HoverEmission(dwellMs: 319, screenPoint: s7, primaryScreenHeight: 1080)
        precondition(tall.hitPoint.x == 604 && tall.hitPoint.y == 409)

        // Global capture merges the ownership evidence without touching the point.
        let evidenced = sampled?.payload(t: 5699, seen: 1,
                                         evidence: ["decision": "record", "owner": ["role": "AXWindow"]]) ?? [:]
        precondition(evidenced["point"] as? [Int] == [604, 671])
        precondition(evidenced["decision"] as? String == "record")

        // The dwell clamp and the rounding are unchanged.
        let plain = HoverEmission(dwellMs: 120, screenPoint: CGPoint(x: 604.4, y: 671.6),
                                  primaryScreenHeight: screenHeight)
        precondition(plain.payloadPoint == [604, 672])
        precondition(plain.payload(t: 0, seen: 0)["dwellMs"] as? Int == 300)
        precondition(HoverEmission(dwellMs: 90_000, screenPoint: s7, primaryScreenHeight: screenHeight)
            .payload(t: 0, seen: 0)["dwellMs"] as? Int == 60_000)
        return 6
    }
}
