import Foundation

@main
struct RecordingClockTests {
    static func main() {
        aPauseIsNotBilledToTheTimeline()
        stoppingWhilePausedKeepsThePauseOut()
        print("Recording clock: 2/2 passed")
    }

    /// Two events either side of a five-second pause are 1.1 s apart, not 6.1 s,
    /// and the pause is reported as 5000 ms.
    static func aPauseIsNotBilledToTheTimeline() {
        let start = 500.0
        var totalPaused = 0.0
        var pausedAt: TimeInterval?

        // Click while recording.
        let click = RecordingClock.activeMs(now: start + 0.2, started: start,
                                           pausedAt: pausedAt, totalPaused: totalPaused)
        // Pause five seconds later, then resume.
        pausedAt = start + 1.0
        // The clock is frozen while paused: nothing is recorded, and time does
        // not advance even though the wall clock does.
        let whilePaused = RecordingClock.activeMs(now: start + 4.0, started: start,
                                                  pausedAt: pausedAt, totalPaused: totalPaused)
        totalPaused += 6.0 - 1.0
        pausedAt = nil
        // Type 0.3 s after resuming.
        let typed = RecordingClock.activeMs(now: start + 6.3, started: start,
                                            pausedAt: pausedAt, totalPaused: totalPaused)
        let paused = RecordingClock.pausedMs(now: start + 6.3, started: start,
                                             pausedAt: pausedAt, totalPaused: totalPaused)

        precondition(click == 200, "click at \(click) ms")
        precondition(whilePaused == 1000, "paused clock read \(whilePaused) ms")
        precondition(typed == 1300, "typed at \(typed) ms")
        // The five seconds of pause are not part of the gap between the steps.
        precondition(typed - click == 1100, "adjacent gap is \(typed - click) ms")
        precondition(paused == 5000, "paused time is \(paused) ms")
    }

    /// Stopping during a pause reports that pause too, and the active clock stops
    /// at the moment the pause began.
    static func stoppingWhilePausedKeepsThePauseOut() {
        let start = 900.0
        var totalPaused = 1.5
        let pausedAt: TimeInterval? = start + 3.0

        let active = RecordingClock.activeMs(now: start + 8.0, started: start,
                                             pausedAt: pausedAt, totalPaused: totalPaused)
        let paused = RecordingClock.pausedMs(now: start + 8.0, started: start,
                                             pausedAt: pausedAt, totalPaused: totalPaused)

        precondition(active == 1500, "active time is \(active) ms")
        precondition(paused == 6500, "paused time is \(paused) ms")
        totalPaused = 0
        let neverPaused = RecordingClock.pausedMs(now: start + 8.0, started: start,
                                                  pausedAt: nil, totalPaused: totalPaused)
        precondition(neverPaused == 0, "an unpaused session reports \(neverPaused) ms")
    }
}
