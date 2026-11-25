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
     * A path we can hand to `readdir`: absolute, NUL-free, not the root.
     *
     * The characters are kept exactly as the source decoded them. Trimming
     * whitespace would rewrite a real folder name — `Folder ` and `Folder` are
     * different folders — and silently move the rename to the wrong one.
     * Nothing here rewrites `..` either: with a symlink in the path that textual
     * rewrite names a folder the source never pointed at, so a path that needs
     * it is left for the caller's directory proof to refuse.
     */
    static func absolutePath(_ raw: String?) -> String? {
        guard let raw, raw.hasPrefix("/"), !raw.contains("\0") else { return nil }
        var path = raw
        while path.count > 1 && path.hasSuffix("/") { path.removeLast() }
        return path == "/" ? nil : path
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
