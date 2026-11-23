import Foundation

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
}
