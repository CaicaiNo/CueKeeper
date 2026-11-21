import AppKit
import CoreGraphics
import Foundation

// Read-only process and window identity for the Cuekeeper CLI. This helper
// never installs an event tap and never asks for Accessibility or Input
// Monitoring: it only reads NSRunningApplication, the process table and
// CGWindowList, and opens one explicit bundle URL on request.

func startMarker(_ pid: pid_t) -> String? {
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    let result = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size)
    guard result == size else { return nil }
    return "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)"
}

func bundlePath(_ application: NSRunningApplication) -> String? {
    guard let url = application.bundleURL else { return nil }
    return url.resolvingSymlinksInPath().path
}

func instance(_ application: NSRunningApplication) -> [String: Any] {
    var record: [String: Any] = [
        "pid": Int(application.processIdentifier),
        "bundleId": application.bundleIdentifier ?? "",
    ]
    if let marker = startMarker(application.processIdentifier) {
        record["startedAt"] = marker
    } else if let launched = application.launchDate {
        record["startedAt"] = String(Int(launched.timeIntervalSince1970))
    } else {
        record["startedAt"] = "unknown-\(application.processIdentifier)"
    }
    if let path = bundlePath(application) {
        record["bundlePath"] = path
    }
    return record
}

func windowList() -> [[String: Any]] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let list = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return []
    }
    return list.compactMap { item in
        guard let number = (item[kCGWindowNumber as String] as? NSNumber)?.intValue, number > 0,
              let owner = (item[kCGWindowOwnerPID as String] as? NSNumber)?.intValue, owner > 0 else {
            return nil
        }
        let layer = (item[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
        // Regular app windows are layer 0; status items, panels and menus are not
        // the window a flow names.
        guard layer == 0 else { return nil }
        return [
            "number": number,
            "ownerPid": owner,
            "title": item[kCGWindowName as String] as? String ?? "",
        ]
    }
}

func emit(_ data: Any?) {
    var envelope: [String: Any] = ["ok": true]
    envelope["data"] = data ?? NSNull()
    guard let line = try? JSONSerialization.data(withJSONObject: envelope) else {
        exit(2)
    }
    FileHandle.standardOutput.write(line)
    FileHandle.standardOutput.write(Data([0x0A]))
}

func fail(_ code: String, _ message: String) -> Never {
    let envelope: [String: Any] = ["ok": false, "error": ["code": code, "message": message]]
    if let line = try? JSONSerialization.data(withJSONObject: envelope) {
        FileHandle.standardOutput.write(line)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
    exit(2)
}

func flag(_ name: String, _ args: [String]) -> String? {
    guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
    return args[index + 1]
}

@main
struct AppIdentityCommand {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let command = args.first else { fail("INPUT_ERROR", "Missing command") }
        switch command {
        case "describe":
            guard let raw = flag("--pid", args), let pid = Int32(raw), pid > 0 else {
                fail("INPUT_ERROR", "describe needs --pid")
            }
            guard let application = NSRunningApplication(processIdentifier: pid) else {
                emit(nil)
                return
            }
            emit(instance(application))
        case "instances":
            guard let bundleId = flag("--bundle-id", args), !bundleId.isEmpty else {
                fail("INPUT_ERROR", "instances needs --bundle-id")
            }
            let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId)
                .filter { !$0.isTerminated }
                .map(instance)
            emit(["instances": running])
        case "windows":
            emit(windowList())
        case "validate":
            guard let path = flag("--path", args), !path.isEmpty else {
                fail("INPUT_ERROR", "validate needs --path")
            }
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            guard let bundle = Bundle(url: url), let bundleId = bundle.bundleIdentifier, !bundleId.isEmpty else {
                emit(nil)
                return
            }
            emit(["bundleId": bundleId, "bundlePath": url.path])
        case "open":
            guard let path = flag("--path", args), !path.isEmpty else {
                fail("INPUT_ERROR", "open needs --path")
            }
            let url = URL(fileURLWithPath: path).resolvingSymlinksInPath()
            let configuration = NSWorkspace.OpenConfiguration()
            configuration.activates = args.contains("--activate")
            configuration.allowsRunningApplicationSubstitution = false
            var opened: Error?
            var finished = false
            NSWorkspace.shared.openApplication(at: url, configuration: configuration) { _, error in
                opened = error
                finished = true
            }
            // The completion handler is delivered on the main queue, so pump the
            // run loop instead of blocking it on a semaphore.
            let deadline = Date().addingTimeInterval(10)
            while !finished && Date() < deadline {
                RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
            }
            if !finished {
                fail("LAUNCH_TIMEOUT", "The application did not finish opening")
            }
            if let opened {
                fail("LAUNCH_FAILED", opened.localizedDescription)
            }
            emit(nil)
        default:
            fail("INPUT_ERROR", "Unknown command")
        }
    }
}
