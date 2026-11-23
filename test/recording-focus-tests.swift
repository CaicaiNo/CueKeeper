import Foundation

@main
struct RecordingFocusTests {
    static func main() {
        aFailedProbeKeepsTheWindowItProved()
        anotherAppNeverInheritsTheWindow()
        anotherProcessNeverInheritsTheWindow()
        aProbedWindowReplacesTheOldOne()
        aSheetIsASurfaceOfTheWindowThatOwnsIt()
        anUntitledSurfaceIsNotANewWindow()
        anOnlyUntitledWindowKeepsItsOwnScope()
        print("Recording focus: 7/7 passed")
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

    /// A sheet is drawn inside the window that presented it. Recording the
    /// sheet as a window of its own sends the typing that follows to a surface
    /// no replay can navigate to, so it resolves to the window that owns it.
    static func aSheetIsASurfaceOfTheWindowThatOwnsIt() {
        let sheet = FocusEvidence.isTransientSurface(
            role: "AXSheet", subrole: "AXStandardWindow", title: "",
            mainTitle: "cuekeeper-demo", isMainWindow: false)
        precondition(sheet, "a sheet was reported as its own window")
        let titled = FocusEvidence.isTransientSurface(
            role: "AXSheet", subrole: nil, title: "Save",
            mainTitle: "Untitled", isMainWindow: false)
        precondition(titled, "a titled sheet was reported as its own window")
    }

    /// Finder's inline rename editor is reported as an untitled window while
    /// the file list stays open. That surface belongs to the titled window the
    /// app keeps, so it must not become a second window key.
    static func anUntitledSurfaceIsNotANewWindow() {
        let editor = FocusEvidence.isTransientSurface(
            role: "AXWindow", subrole: nil, title: "", mainTitle: "cuekeeper-demo",
            isMainWindow: false)
        precondition(editor, "an untitled rename editor was reported as its own window")
        let titled = FocusEvidence.isTransientSurface(
            role: "AXWindow", subrole: "AXStandardWindow", title: "cuekeeper-demo",
            mainTitle: "cuekeeper-demo", isMainWindow: true)
        precondition(!titled, "a titled window was reported as a surface")
    }

    /// An app whose only window has no title yet keeps it: nothing else can own
    /// it, and dropping its number would leave every event without a scope.
    static func anOnlyUntitledWindowKeepsItsOwnScope() {
        let only = FocusEvidence.isTransientSurface(
            role: "AXWindow", subrole: nil, title: "", mainTitle: "", isMainWindow: true)
        precondition(!only, "the app's only untitled window lost its scope")
        let untitledMain = FocusEvidence.isTransientSurface(
            role: "AXWindow", subrole: nil, title: "  ", mainTitle: nil, isMainWindow: false)
        precondition(!untitledMain, "an untitled window without a titled owner lost its scope")
    }
}
