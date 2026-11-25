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
        theWindowDocumentNamesItsFolder()
        aMissingDocumentFallsBackToTheRowParent()
        aMultipleSelectionHasNoSingleFolder()
        anUnreadableRowURLCannotProveAFolder()
        aNonAbsoluteDocumentFallsBackToTheRow()
        print("Recording focus: 12/12 passed")
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

    /// A folder window that exposes AXDocument names the folder directly; the
    /// row's file URL is irrelevant.
    static func theWindowDocumentNamesItsFolder() {
        let folder = RenameDirectory.resolve(
            document: "/Users/qa/Downloads", rowURL: "/Users/qa/Downloads/manifest.json", selectedCount: 1)
        precondition(folder == "/Users/qa/Downloads", "document folder became \(String(describing: folder))")
    }

    /// Finder folder windows do not always expose AXDocument. The target row's
    /// own file URL still names the file, so its parent is the rename folder.
    static func aMissingDocumentFallsBackToTheRowParent() {
        let folder = RenameDirectory.resolve(
            document: nil, rowURL: "/Users/qa/Downloads/manifest.json", selectedCount: 0)
        precondition(folder == "/Users/qa/Downloads", "row folder became \(String(describing: folder))")
        let selected = RenameDirectory.resolve(
            document: nil, rowURL: "/Users/qa/Downloads/manifest.json", selectedCount: 1)
        precondition(selected == "/Users/qa/Downloads", "single selection became \(String(describing: selected))")
    }

    /// Multiple selected rows can belong to different folders (search results,
    /// expanded subfolders). No single folder is provable.
    static func aMultipleSelectionHasNoSingleFolder() {
        let folder = RenameDirectory.resolve(
            document: nil, rowURL: "/Users/qa/Downloads/manifest.json", selectedCount: 2)
        precondition(folder == nil, "a multiple selection produced \(String(describing: folder))")
    }

    /// A row without a file URL, or one that names a relative path, proves no
    /// folder at all — the caller must report the directory as unproven.
    static func anUnreadableRowURLCannotProveAFolder() {
        let missing = RenameDirectory.resolve(document: nil, rowURL: nil, selectedCount: 1)
        precondition(missing == nil, "a missing row URL produced \(String(describing: missing))")
        let relative = RenameDirectory.resolve(document: nil, rowURL: "Downloads/manifest.json", selectedCount: 1)
        precondition(relative == nil, "a relative row URL produced \(String(describing: relative))")
    }

    /// A document that is not an absolute path is not a folder; the row still
    /// is, so the fallback is used. With neither source there is no answer.
    static func aNonAbsoluteDocumentFallsBackToTheRow() {
        let fallback = RenameDirectory.resolve(
            document: "Downloads", rowURL: "/Users/qa/Downloads/manifest.json", selectedCount: 1)
        precondition(fallback == "/Users/qa/Downloads", "relative document became \(String(describing: fallback))")
        let nothing = RenameDirectory.resolve(document: "Downloads", rowURL: nil, selectedCount: 1)
        precondition(nothing == nil, "relative document alone produced \(String(describing: nothing))")
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
