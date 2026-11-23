import Foundation

@main
struct RecordingFocusTests {
    static func main() {
        aFailedProbeKeepsTheWindowItProved()
        anotherAppNeverInheritsTheWindow()
        anotherProcessNeverInheritsTheWindow()
        aProbedWindowReplacesTheOldOne()
        print("Recording focus: 4/4 passed")
    }

    /// Finder's inline rename field makes the window probe fail. The app and its
    /// process did not change, so the window it proved before is kept and the
    /// characters typed into the field still have a scope.
    static func aFailedProbeKeepsTheWindowItProved() {
        let kept = FocusEvidence.windowNumber(
            probed: nil, pid: 501, app: "com.apple.finder",
            previousPid: 501, previousApp: "com.apple.finder", previousWindow: 42)
        precondition(kept == 42, "a failed probe of the same app kept \(String(describing: kept))")
    }

    /// Switching to another app and failing to probe its window must not reuse
    /// the window the previous app proved.
    static func anotherAppNeverInheritsTheWindow() {
        let dropped = FocusEvidence.windowNumber(
            probed: nil, pid: 777, app: "com.apple.TextEdit",
            previousPid: 501, previousApp: "com.apple.finder", previousWindow: 42)
        precondition(dropped == nil, "another app inherited window \(String(describing: dropped))")
    }

    /// A relaunch of the same bundle is another process; its windows are not the
    /// ones the old process proved.
    static func anotherProcessNeverInheritsTheWindow() {
        let dropped = FocusEvidence.windowNumber(
            probed: nil, pid: 999, app: "com.apple.finder",
            previousPid: 501, previousApp: "com.apple.finder", previousWindow: 42)
        precondition(dropped == nil, "a relaunched app inherited window \(String(describing: dropped))")
        let unnamed = FocusEvidence.windowNumber(
            probed: nil, pid: 501, app: nil,
            previousPid: 501, previousApp: "com.apple.finder", previousWindow: 42)
        precondition(unnamed == nil, "an unnamed app inherited window \(String(describing: unnamed))")
    }

    /// A successful probe always wins, including when the app moved to another
    /// window or the window number changed.
    static func aProbedWindowReplacesTheOldOne() {
        let replaced = FocusEvidence.windowNumber(
            probed: 77, pid: 501, app: "com.apple.finder",
            previousPid: 501, previousApp: "com.apple.finder", previousWindow: 42)
        precondition(replaced == 77, "a probed window became \(String(describing: replaced))")
    }
}
