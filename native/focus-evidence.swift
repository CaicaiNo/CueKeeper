import Foundation

/**
 * The folder a Finder rename applies to.
 *
 * A Finder folder window does not always expose `AXDocument`. The selected (or
 * hit-tested target) row's `AXURL` names the file itself, so its parent folder
 * is the same folder the rename would happen in. A multiple selection has no
 * single folder, and a path that is not absolute proves nothing: both are
 * rejected so the caller can report `RENAME_DIRECTORY_UNPROVEN`.
 */
enum RenameDirectory {
    /**
     * Resolve one folder from the two read-only sources, in order:
     * the window document first, then the target row's file URL.
     */
    static func resolve(document: String?, rowURL: String?, selectedCount: Int?) -> String? {
        if let path = absolutePath(document) { return path }
        if let count = selectedCount, count > 1 { return nil }
        guard let file = absolutePath(rowURL) else { return nil }
        let parent = (file as NSString).deletingLastPathComponent
        return parent.isEmpty || parent == "/" ? nil : parent
    }

    /** A path we can hand to `readdir`: absolute, NUL-free, not the root. */
    private static func absolutePath(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/"), !trimmed.contains("\0") else { return nil }
        let standard = (trimmed as NSString).standardizingPath
        return standard.isEmpty || standard == "/" ? nil : standard
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
