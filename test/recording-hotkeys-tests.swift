@main
struct RecordingHotkeyTests {
    static func main() {
        filtersControlKeysBeforeTargetAndRecorder()
        forwardsOrdinaryShortcuts()
        print("Recording hotkeys: 2/2 passed")
    }

    static func filtersControlKeysBeforeTargetAndRecorder() {
        var hotkeys = RecordingHotkeys()
        var targetText: [UInt8] = []
        var flow: [String] = ["click"]

        // The two downstream consumers see only events the production filter forwards.
        func send(code: Int, down: Bool, chord: Bool = false, repeating: Bool = false,
                  input: [UInt8] = [], step: String? = nil) -> RecordingHotkeys.Action {
            let action = hotkeys.route(code: code, down: down, matchesChord: chord, repeating: repeating)
            if !action.consumesEvent {
                targetText.append(contentsOf: input)
                if let step { flow.append(step) }
            }
            return action
        }

        precondition(send(code: 8, down: true, input: Array("Cuekeeper M1".utf8), step: "type") == .forward)
        precondition(send(code: 1, down: true, step: "key(meta+s)") == .forward)
        precondition(send(code: 35, down: true, chord: true, input: [0x10], step: "key(ctrl+alt+p)") == .togglePause)
        precondition(send(code: 35, down: true, chord: true, repeating: true, input: [0x10]) == .consume)
        precondition(send(code: 35, down: false, step: "keyup(p)") == .consume)
        precondition(send(code: 35, down: true, chord: true, input: [0x10], step: "key(ctrl+alt+p)") == .togglePause)
        precondition(send(code: 35, down: false) == .consume)
        precondition(send(code: 7, down: true, chord: true, input: [0x18], step: "key(ctrl+alt+x)") == .requestStop)
        precondition(send(code: 7, down: true, repeating: true, input: [0x18]) == .consume)
        precondition(send(code: 7, down: false, step: "keyup(x)") == .releaseStop)

        precondition(targetText == Array("Cuekeeper M1".utf8), "Target received unexpected control bytes")
        precondition(flow == ["click", "type", "key(meta+s)"], "Flow received a recording hotkey")
    }

    static func forwardsOrdinaryShortcuts() {
        var hotkeys = RecordingHotkeys()
        for code in [7, 35] {
            // A nonmatching chord can be an ordinary Ctrl+X/P, Cmd+X/P, or plain typing.
            precondition(hotkeys.route(code: code, down: true, matchesChord: false, repeating: false) == .forward)
            precondition(hotkeys.route(code: code, down: true, matchesChord: true, repeating: true) == .consume)
            precondition(hotkeys.route(code: code, down: false, matchesChord: true, repeating: false) == .forward)
        }
    }
}
