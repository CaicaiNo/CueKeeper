import Foundation

/**
 * The folder a Finder rename applies to.
 *
 * A Finder folder window does not always expose `AXDocument`. The target row's
 * `AXURL` names the file itself, so its parent folder is the same folder the
 * rename would happen in. A row URL alone is not enough, though: the row and
 * its list have to sit in the bound folder window, and the list has to prove
 * which rows are selected. Without that evidence the URL could describe a row
 * of another window or folder. A multiple selection has no single folder, and
 * a path that is not absolute proves nothing: all of them are rejected so the
 * caller can report `RENAME_DIRECTORY_UNPROVEN`.
 */
enum RenameDirectory {
    /**
     * One read of the file list around the recorded point, as the native probe
     * found it. Every field is required except the two optional raw values: a
     * missing URL or a missing selection is a failed proof, not an empty one.
     */
    struct RowEvidence {
        /** The row's own file URL, when Finder exposes one. */
        var url: String?
        /** The filename the row currently shows, when Finder names it. */
        var name: String?
        /** Number of selected rows the list reports; nil when it exposes none. */
        var selectedCount: Int?
        /** Whether the row under the recorded point is one of the selected rows. */
        var targetSelected: Bool
        /** Whether the row and its containing list belong to the bound window. */
        var inBoundWindow: Bool
    }

    /**
     * Resolve one folder from the two read-only sources, in order: the window
     * document first, then the target row's file URL.
     *
     * `expected` is the recorded filename while the caller is still deriving
     * the folder. It becomes nil once the caller has pinned one: the editor
     * then shows the new name while the row still carries the file's URL.
     * `pinned` is a folder the caller already proved; an answer naming another
     * folder is refused instead of replacing it.
     */
    static func resolve(document: String?, row: RowEvidence?, expected: String?, pinned: String?) -> String? {
        if let path = absolutePath(document) {
            return pinned == nil || pinned == path ? path : nil
        }
        guard let row, row.inBoundWindow, let count = row.selectedCount else { return nil }
        if let expected, row.name != expected { return nil }
        switch count {
        case 0:
            // Before the row is selected, zero selection is provable evidence.
            // Once the folder is pinned the target row must still be selected.
            guard expected != nil, !row.targetSelected else { return nil }
        case 1:
            guard row.targetSelected else { return nil }
        default:
            return nil
        }
        guard let file = absolutePath(row.url) else { return nil }
        let parent = (file as NSString).deletingLastPathComponent
        guard !parent.isEmpty, parent != "/" else { return nil }
        guard let pinned else { return parent }
        return parent == pinned ? parent : nil
    }

    /**
     * A path we can hand to `readdir`: absolute, NUL-free, not the root, and
     * free of `.` / `..` segments.
     *
     * The characters are kept exactly as the source decoded them. Trimming
     * whitespace would rewrite a real folder name — `Folder ` and `Folder` are
     * different folders — and silently move the rename to the wrong one.
     * Nothing here rewrites `..` either: with a symlink in the path that textual
     * rewrite names a folder the source never pointed at, so such a path is
     * refused instead of normalised. The caller reports
     * `RENAME_DIRECTORY_UNPROVEN` and sends no input.
     */
    static func absolutePath(_ raw: String?) -> String? {
        guard let raw, raw.hasPrefix("/"), !raw.contains("\0") else { return nil }
        var path = raw
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        guard path != "/", !path.split(separator: "/", omittingEmptySubsequences: false)
            .contains(where: { $0 == "." || $0 == ".." }) else { return nil }
        return path
    }
}

/**
 * The windows one process owns, as its accessibility answer really contains
 * them.
 *
 * `kAXWindowsAttribute` is not limited to windows: Finder also lists the
 * desktop's content scroll area (no subrole, no window number) beside its folder
 * windows. Only an `AXWindow` can own a context menu, so anything else is not a
 * window the menu could belong to. An `AXWindow` whose number cannot be resolved
 * makes the whole answer incomplete rather than silently smaller — a caller that
 * wants to rule out other owners must not read a partial list as a complete one.
 */
/**
 * What a menu read may say about the selection.
 *
 * The row evidence is the only source, and a menu read proves everything the
 * closed-menu path would: the row and its list sit in the bound window, the row
 * shows the recorded old name, the row's own URL names that exact file of the
 * pinned folder, and the list reports that row as its only selection. A
 * document that decided the folder cannot make up for a failed row: a
 * same-named file of an expanded subfolder, a row of another window, or a top
 * level row that exposes no URL all prove nothing, and the caller must stop
 * before pressing the menu item. The selection is reported only when every one
 * of those checks holds at once.
 */
enum RenameSelection {
    struct MenuEvidence: Equatable {
        var selectedCount: Int?
        var targetSelected: Bool
    }

    static func menuEvidence(_ row: RenameDirectory.RowEvidence?, expectedName: String,
                             expectedPath: String) -> MenuEvidence {
        guard let row, row.inBoundWindow, row.name == expectedName,
              row.selectedCount == 1, row.targetSelected,
              row.url == expectedPath else {
            return MenuEvidence(selectedCount: nil, targetSelected: false)
        }
        return MenuEvidence(selectedCount: 1, targetSelected: true)
    }
}

enum AppWindowInventory {
    struct Answer: Equatable {
        var complete: Bool
        var numbers: [Int]
        var titles: [String]
    }

    static func answer(entries: [(role: String, number: Int?, title: String)]) -> Answer {
        var numbers: [Int] = []
        var titles: [String] = []
        var complete = true
        for entry in entries where entry.role == "AXWindow" {
            titles.append(entry.title)
            if let number = entry.number {
                numbers.append(number)
            } else {
                complete = false
            }
        }
        return Answer(complete: complete, numbers: numbers, titles: titles)
    }
}

enum RenameRow {
    /**
     * Whether a row names the recorded file.
     *
     * The row's own URL must name that exact file in the pinned folder. A row
     * that exposes no URL only qualifies when it is a top level row of that
     * folder — never a same-named file of an expanded subfolder, which can be
     * drawn at the very point the recorded row occupies. A URL that is not a
     * readable file URL proves nothing.
     */
    static func namesRecordedFile(url: String?, disclosureLevel: Int?, expectedPath: String) -> Bool {
        if let url {
            guard let file = URL(string: url), file.isFileURL else { return false }
            return file.standardizedFileURL.path == expectedPath
        }
        return disclosureLevel == 0
    }
}

/**
 * The window evidence one focus probe can prove.
 *
 * A probe reads the frontmost app and the window that app reports as focused.
 * That read can fail while the app keeps working: Finder opens an inline rename
 * field, a window is mid-animation, or a sheet makes the focused window
 * unreadable. A failed probe must not erase the window the same app process had
 * just proved, because every later event of that process would lose its scope.
 */
struct FocusEvidence {
    /**
     * The window number to keep after a probe.
     *
     * A probed number always wins. A missing one is filled from the window the
     * same app and process proved before; another app, another process, or an
     * app that cannot be named never inherits it.
     */
    static func windowNumber(probed: Int?, pid: Int32?, app: String?,
                             previousPid: Int32?, previousApp: String?,
                             previousWindow: Int?) -> Int? {
        if let probed { return probed }
        guard let app, pid != nil, pid == previousPid, app == previousApp else { return nil }
        return previousWindow
    }

    /**
     * Whether the reported AX window is a surface of another window rather than
     * a window the user can be sent back to.
     *
     * A sheet or a dialog always is. An untitled one is when the app keeps a
     * different titled window it can belong to; an app whose only window is
     * untitled keeps it, because nothing else can own it.
     */
    static func isTransientSurface(role: String?, subrole: String?, title: String?,
                                   mainTitle: String?, isMainWindow: Bool) -> Bool {
        if role == "AXSheet" || role == "AXDialog" || subrole == "AXSheet" || subrole == "AXDialog" {
            return true
        }
        guard (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return false }
        return !isMainWindow && !(mainTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
