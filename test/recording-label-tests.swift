import Foundation

@main
struct RecordingLabelTests {
    static func main() {
        aRecordingNeverAdvertisesAWarmUp()
        aRecordingShowsTheClockAndKeys()
        aPauseRelabelsTheSameRecording()
        aReplayKeepsItsOwnWording()
        secondMarksAreNotRoundedUp()
        print("Recording label: 6/6 passed")
    }

    /// The HUD only exists once capture began, so a freshly started plate must
    /// already say "录制中". "录制就绪" was the old warm-up label and may not
    /// come back through any input, including the starting flag.
    static func aRecordingNeverAdvertisesAWarmUp() {
        for starting in [true, false] {
            let text = IndicatorLabel.text(mode: .recording, elapsed: 0, paused: false, starting: starting)
            precondition(!text.contains("就绪"), "starting=\(starting) still says \(text)")
            precondition(!text.contains("准备"), "starting=\(starting) still says \(text)")
            precondition(text.hasPrefix("录制中  00:00"), "starting=\(starting) says \(text)")
        }
    }

    /// The live words name the clock and both hotkeys, so an operator reading
    /// only the HUD knows how long it has run and how to pause or stop.
    static func aRecordingShowsTheClockAndKeys() {
        let text = IndicatorLabel.text(mode: .recording, elapsed: 83, paused: false, starting: false)
        precondition(text == "录制中  01:23     ⌃⌥P 暂停   ⌃⌥X 停止", "elapsed 83 s reads \(text)")
    }

    /// A pause keeps the elapsed clock frozen and offers resume, not pause.
    static func aPauseRelabelsTheSameRecording() {
        let text = IndicatorLabel.text(mode: .recording, elapsed: 5, paused: true, starting: false)
        precondition(text == "已暂停  00:05     ⌃⌥P 继续   ⌃⌥X 停止", "paused reads \(text)")
    }

    /// Replay keeps its own wording and only offers the cancel chord; the
    /// recording states must not leak into it.
    static func aReplayKeepsItsOwnWording() {
        for elapsed in [0, 61] {
            let text = IndicatorLabel.text(mode: .replay, elapsed: elapsed, paused: false, starting: true)
            precondition(text.hasPrefix("回放中  "), "replay reads \(text)")
            precondition(!text.contains("暂停") && !text.contains("录制中"), "replay reads \(text)")
        }
        let text = IndicatorLabel.text(mode: .replay, elapsed: 61, paused: false, starting: false)
        precondition(text == "回放中  01:01     ⌃⌥X 取消", "replay reads \(text)")
    }

    /// A negative or partial second is floored, never rendered as a fraction
    /// or counted up: the clock may only report whole elapsed seconds.
    static func secondMarksAreNotRoundedUp() {
        let negative = IndicatorLabel.text(mode: .recording, elapsed: -2, paused: false, starting: false)
        precondition(negative.hasPrefix("录制中  00:00"), "negative elapsed reads \(negative)")
        let partial = IndicatorLabel.text(mode: .recording, elapsed: 1, paused: false, starting: false)
        precondition(partial.hasPrefix("录制中  00:01"), "one second reads \(partial)")
    }
}
