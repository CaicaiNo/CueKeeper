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
        aMissingSelectionProvesNoFolder()
        aRowOutsideTheBoundWindowProvesNoFolder()
        aPinnedFolderMustMatchTheFallback()
        aZeroSelectionOnlyProvesTheFolderBeforeSelecting()
        print("Recording focus: 17/17 passed")
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

    /// The row evidence a Finder list around the target row normally proves.
    static func selectedRow(count: Int? = 1, selected: Bool = true, name: String? = "manifest.json",
                            url: String? = "/Users/qa/Downloads/manifest.json",
                            bound: Bool = true) -> RenameDirectory.RowEvidence {
        RenameDirectory.RowEvidence(
            url: url, name: name, selectedCount: count, targetSelected: selected, inBoundWindow: bound)
    }

    /// A folder window that exposes AXDocument names the folder directly; the
    /// row's file URL is irrelevant.
    static func theWindowDocumentNamesItsFolder() {
        let folder = RenameDirectory.resolve(
            document: "/Users/qa/Downloads", row: nil, expected: nil, pinned: nil)
        precondition(folder == "/Users/qa/Downloads", "document folder became \(String(describing: folder))")
        // The document wins even when the row would name another folder.
        let wins = RenameDirectory.resolve(
            document: "/Users/qa/Downloads",
            row: selectedRow(url: "/Users/qa/Desktop/manifest.json"), expected: nil, pinned: nil)
        precondition(wins == "/Users/qa/Downloads", "row replaced the document with \(String(describing: wins))")
    }

    /// Finder folder windows do not always expose AXDocument. The target row's
    /// own file URL still names the file, so its parent is the rename folder.
    static func aMissingDocumentFallsBackToTheRowParent() {
        let folder = RenameDirectory.resolve(
            document: nil, row: selectedRow(count: 0, selected: false), expected: "manifest.json", pinned: nil)
        precondition(folder == "/Users/qa/Downloads", "row folder became \(String(describing: folder))")
        let selected = RenameDirectory.resolve(
            document: nil, row: selectedRow(), expected: "manifest.json", pinned: nil)
        precondition(selected == "/Users/qa/Downloads", "single selection became \(String(describing: selected))")
    }

    /// Multiple selected rows can belong to different folders (search results,
    /// expanded subfolders). No single folder is provable.
    static func aMultipleSelectionHasNoSingleFolder() {
        let folder = RenameDirectory.resolve(
            document: nil, row: selectedRow(count: 2), expected: "manifest.json", pinned: nil)
        precondition(folder == nil, "a multiple selection produced \(String(describing: folder))")
    }

    /// A row without a file URL, or one that names a relative path, proves no
    /// folder at all — the caller must report the directory as unproven.
    static func anUnreadableRowURLCannotProveAFolder() {
        let missing = RenameDirectory.resolve(
            document: nil, row: selectedRow(url: nil), expected: "manifest.json", pinned: nil)
        precondition(missing == nil, "a missing row URL produced \(String(describing: missing))")
        let relative = RenameDirectory.resolve(
            document: nil, row: selectedRow(url: "Downloads/manifest.json"), expected: "manifest.json", pinned: nil)
        precondition(relative == nil, "a relative row URL produced \(String(describing: relative))")
    }

    /// A document that is not an absolute path is not a folder; the row still
    /// is, so the fallback is used. With neither source there is no answer.
    static func aNonAbsoluteDocumentFallsBackToTheRow() {
        let fallback = RenameDirectory.resolve(
            document: "Downloads", row: selectedRow(), expected: "manifest.json", pinned: nil)
        precondition(fallback == "/Users/qa/Downloads", "relative document became \(String(describing: fallback))")
        let nothing = RenameDirectory.resolve(
            document: "Downloads", row: selectedRow(url: nil), expected: "manifest.json", pinned: nil)
        precondition(nothing == nil, "relative document alone produced \(String(describing: nothing))")
    }

    /// A list that does not report its selection cannot authorize a row URL:
    /// the URL could belong to any row the point happens to fall on.
    static func aMissingSelectionProvesNoFolder() {
        let noSelection = RenameDirectory.resolve(
            document: nil, row: selectedRow(count: nil), expected: "manifest.json", pinned: nil)
        precondition(noSelection == nil, "missing selection evidence produced \(String(describing: noSelection))")
        let unselected = RenameDirectory.resolve(
            document: nil, row: selectedRow(selected: false), expected: "manifest.json", pinned: nil)
        precondition(unselected == nil, "an unselected row produced \(String(describing: unselected))")
    }

    /// The row and its list have to belong to the bound folder window. The same
    /// point can fall on an overlapping window of the same Finder.
    static func aRowOutsideTheBoundWindowProvesNoFolder() {
        let outside = RenameDirectory.resolve(
            document: nil, row: selectedRow(bound: false), expected: "manifest.json", pinned: nil)
        precondition(outside == nil, "a row in another window produced \(String(describing: outside))")
    }

    /// Once the caller pinned a folder, the fallback must name that same folder.
    static func aPinnedFolderMustMatchTheFallback() {
        let agreed = RenameDirectory.resolve(
            document: nil, row: selectedRow(name: nil), expected: nil, pinned: "/Users/qa/Downloads")
        precondition(agreed == "/Users/qa/Downloads", "a matching pin became \(String(describing: agreed))")
        let changed = RenameDirectory.resolve(
            document: nil, row: selectedRow(name: nil, url: "/Users/qa/Desktop/manifest.json"),
            expected: nil, pinned: "/Users/qa/Downloads")
        precondition(changed == nil, "a different pinned folder produced \(String(describing: changed))")
        let documentChanged = RenameDirectory.resolve(
            document: "/Users/qa/Desktop", row: nil, expected: nil, pinned: "/Users/qa/Downloads")
        precondition(documentChanged == nil, "a changed document produced \(String(describing: documentChanged))")
    }

    /// Zero selection proves the folder only before the target row is selected,
    /// and only while the row under the point is the recorded file.
    static func aZeroSelectionOnlyProvesTheFolderBeforeSelecting() {
        let afterPinning = RenameDirectory.resolve(
            document: nil, row: selectedRow(count: 0, selected: false, name: nil), expected: nil,
            pinned: "/Users/qa/Downloads")
        precondition(afterPinning == nil, "a zero selection after pinning produced \(String(describing: afterPinning))")
        let otherRow = RenameDirectory.resolve(
            document: nil, row: selectedRow(count: 0, selected: false, name: "other.json"),
            expected: "manifest.json", pinned: nil)
        precondition(otherRow == nil, "zero selection on another row produced \(String(describing: otherRow))")
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
