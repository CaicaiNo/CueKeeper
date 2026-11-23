import Foundation

/**
 * The clock a recording's events are stamped with.
 *
 * It measures the time the user was actually recording: uptime since the first
 * step, minus every interval spent paused. A pause that has not been resumed
 * yet freezes the clock at the moment it began, so stopping while paused never
 * bills the pause either. The wall clock (`seen`) is a different clock and keeps
 * running through a pause; only step times use this one.
 */
enum RecordingClock {
    /** How many milliseconds the recording actually ran. */
    static func activeMs(now: TimeInterval, started: TimeInterval,
                         pausedAt: TimeInterval?, totalPaused: TimeInterval) -> Int {
        let end = pausedAt ?? now
        return max(0, Int(((end - started - max(0, totalPaused)) * 1000).rounded()))
    }

    /** How many milliseconds were spent paused, including a pause still open. */
    static func pausedMs(now: TimeInterval, started: TimeInterval,
                         pausedAt: TimeInterval?, totalPaused: TimeInterval) -> Int {
        var paused = max(0, totalPaused)
        if let pausedAt { paused += max(0, now - pausedAt) }
        return max(0, Int((paused * 1000).rounded()))
    }
}
