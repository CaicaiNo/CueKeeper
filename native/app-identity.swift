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

// MARK: - Read-only executable identity and bounded argv

// The process table's `comm` column is argv[0], which any process may rewrite.
// Identity therefore comes from proc_pidpath, and arguments come from
// KERN_PROCARGS2 with an explicit argc: `ps args` joins arguments into text and
// loses the boundary between one argument containing a space and two arguments.
// Nothing here writes, launches, focuses or asks for a permission.

let maxProcessRows = 8192
let maxExecutableBytes = 4096
let maxArgvBytes = 256 * 1024
// A saved argument is at most 4096 UTF-16 code units, which is at most 12288
// UTF-8 bytes (CJK BMP text); the transfer and the matcher accept that whole
// value instead of rejecting a legal argument as unreadable.
let maxExpectedArgBytes = 12_288
// An observed argv element longer than any savable argument is carried as a
// sentinel one byte longer than the limit: it can never equal a saved value,
// and it does not stop a short argument elsewhere from matching.
let maxCarriedArgBytes = maxExpectedArgBytes + 1
let maxStdinBytes = 1024 * 1024
let maxArgCount = 32

struct ArgvRequest: Codable {
    let pid: Int32
    let executable: String
    let startedAt: String
    let args: [String]
}

struct IdentityRequest: Codable {
    let pids: [Int32]
}

/// What this helper could prove about one enumerated PID. Either field may be
/// missing: a live process whose image was deleted or is protected keeps its
/// PID entry so the caller can call it unknown instead of absent, while a PID
/// that vanished between `ps` and this read is omitted.
struct ProcessRow {
    let pid: pid_t
    let executable: String?
    /// Kernel short executable name (`pbi_name`), not the process's argv[0].
    /// It survives an unlinked image, so a caller can exclude a live PID that
    /// cannot be the one it asks about.
    let name: String?
    let startedAt: String?
}

/// `pbi_name` is a fixed 32-byte field; a longer basename is truncated there.
func kernelName(_ info: proc_bsdinfo) -> String? {
    var field = info.pbi_name
    let bytes = withUnsafeBytes(of: &field) { raw -> [UInt8] in
        Array(raw.prefix { $0 != 0 })
    }
    guard !bytes.isEmpty, let value = String(bytes: bytes, encoding: .utf8) else { return nil }
    return value
}

func processRow(_ pid: pid_t) -> ProcessRow? {
    var info = proc_bsdinfo()
    let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    let infoResult = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, infoSize)
    let infoError = errno
    var pathBuffer = [UInt8](repeating: 0, count: maxExecutableBytes)
    let length = proc_pidpath(pid, &pathBuffer, UInt32(maxExecutableBytes))
    let pathError = errno
    let readableInfo = infoResult == infoSize
    let executable: String? = length > 0 && Int(length) < maxExecutableBytes
        ? String(bytes: pathBuffer[0..<Int(length)], encoding: .utf8) : nil
    // Neither probe naming anything and one of them reporting ESRCH means the
    // PID is gone. Every other combination is a live process kept as unknown.
    if !readableInfo && executable == nil && (infoError == ESRCH || pathError == ESRCH) { return nil }
    return ProcessRow(
        pid: pid,
        executable: executable,
        name: readableInfo ? kernelName(info) : nil,
        startedAt: readableInfo ? "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)" : nil
    )
}

func processRows(_ pids: [Int32]) -> [[String: Any]] {
    var rows: [[String: Any]] = []
    for raw in pids.prefix(maxProcessRows) {
        let pid = pid_t(raw)
        guard pid > 0, let row = processRow(pid) else { continue }
        var record: [String: Any] = ["pid": Int(row.pid)]
        if let executable = row.executable { record["executable"] = executable }
        if let name = row.name { record["name"] = name }
        // Only a readable generation marker can prove a PID was not reused.
        if let startedAt = row.startedAt { record["startedAt"] = startedAt }
        rows.append(record)
    }
    return rows
}

/// Reads at most `maxArgvBytes` of KERN_PROCARGS2 and returns exactly `argc`
/// arguments. A truncated or non-UTF-8 buffer is unreadable, never a mismatch.
func readArguments(_ pid: pid_t) -> [String]? {
    var argMax: Int32 = 0
    var argMaxSize = MemoryLayout<Int32>.size
    var argMaxMib: [Int32] = [CTL_KERN, KERN_ARGMAX]
    guard sysctl(&argMaxMib, 2, &argMax, &argMaxSize, nil, 0) == 0, argMax > 0 else { return nil }
    let capacity = min(Int(argMax), maxArgvBytes)
    guard capacity > MemoryLayout<Int32>.size else { return nil }
    var buffer = [UInt8](repeating: 0, count: capacity)
    var size = capacity
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    guard sysctl(&mib, 3, &buffer, &size, nil, 0) == 0,
          size > MemoryLayout<Int32>.size else { return nil }
    let argc = buffer.withUnsafeBytes { $0.load(as: Int32.self) }
    guard argc > 0, Int(argc) <= 4096 else { return nil }
    var index = MemoryLayout<Int32>.size
    // The exec path follows argc; skip it and any NUL padding after it.
    while index < size, buffer[index] != 0 { index += 1 }
    guard index < size else { return nil }
    index += 1
    while index < size, buffer[index] == 0 { index += 1 }
    var arguments: [String] = []
    for _ in 0..<Int(argc) {
        let start = index
        while index < size, buffer[index] != 0 { index += 1 }
        guard index < size else { return nil }
        let slice = buffer[start..<index]
        if slice.count <= maxCarriedArgBytes, let value = String(bytes: slice, encoding: .utf8) {
            arguments.append(value)
        } else {
            // Too long for any savable value (or not UTF-8): keep the position
            // as a sentinel that cannot equal an expected argument, so an
            // unrelated long element never makes a short one unreadable.
            arguments.append(String(repeating: "\u{0}", count: maxCarriedArgBytes))
        }
        index += 1
    }
    return arguments
}

/// True when `expected` equals one contiguous, same-order run of argv[1...].
/// argv[0] is the process-chosen name, so it is never compared. Swift `String`
/// equality uses canonical equivalence, which would treat `e` + U+0301 and
/// U+00E9 as equal; arguments are compared as UTF-8 bytes so the literal value
/// the process received is the only value that matches.
func containsContiguous(_ argv: [String], _ expected: [String]) -> Bool {
    guard !expected.isEmpty else { return false }
    let haystack = argv.dropFirst().map { Array($0.utf8) }
    let needle = expected.map { Array($0.utf8) }
    guard haystack.count >= needle.count else { return false }
    for start in 0...(haystack.count - needle.count)
    where Array(haystack[start..<(start + needle.count)]) == needle {
        return true
    }
    return false
}

func readBoundedStdin() -> Data? {
    var data = Data()
    let handle = FileHandle.standardInput
    while data.count <= maxStdinBytes {
        let chunk = handle.availableData
        if chunk.isEmpty { break }
        data.append(chunk)
    }
    guard !data.isEmpty, data.count <= maxStdinBytes else { return nil }
    return data
}

/// Matches one bounded request. Any identity change around the argv read, an
/// unreadable argv, or a candidate of another UID is `unknown`: the caller must
/// not turn it into a mismatch, because a reverse check would then pass.
func argvStatus(_ request: ArgvRequest) -> String {
    guard request.pid > 0, !request.args.isEmpty, request.args.count <= maxArgCount,
          request.args.allSatisfy({
              !$0.isEmpty && $0.utf8.count <= maxExpectedArgBytes && !$0.contains("\0")
          }) else { return "unknown" }
    guard let before = liveIdentity(request.pid),
          before.uid == geteuid(),
          before.startedAt == request.startedAt,
          before.executable == request.executable else { return "unknown" }
    guard let argv = readArguments(request.pid) else { return "unknown" }
    guard let after = liveIdentity(request.pid),
          after.uid == before.uid,
          after.startedAt == before.startedAt,
          after.executable == before.executable else { return "unknown" }
    return containsContiguous(argv, request.args) ? "matched" : "unmatched"
}

struct LiveIdentity {
    let uid: uid_t
    let startedAt: String
    let executable: String
}

/// A full identity for the argv path: bsdinfo and proc_pidpath must both answer.
func liveIdentity(_ pid: pid_t) -> LiveIdentity? {
    var info = proc_bsdinfo()
    let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, infoSize) == infoSize else { return nil }
    var pathBuffer = [UInt8](repeating: 0, count: maxExecutableBytes)
    let length = proc_pidpath(pid, &pathBuffer, UInt32(maxExecutableBytes))
    guard length > 0, Int(length) < maxExecutableBytes,
          let executable = String(bytes: pathBuffer[0..<Int(length)], encoding: .utf8) else { return nil }
    return LiveIdentity(
        uid: info.pbi_uid,
        startedAt: "\(info.pbi_start_tvsec).\(info.pbi_start_tvusec)",
        executable: executable
    )
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
        case "process-identities":
            guard let body = readBoundedStdin(),
                  let request = try? JSONDecoder().decode(IdentityRequest.self, from: body) else {
                fail("INPUT_ERROR", "process-identities needs one bounded JSON request on stdin")
            }
            emit(["processes": processRows(request.pids)])
        case "process-argv":
            guard let body = readBoundedStdin(),
                  let request = try? JSONDecoder().decode(ArgvRequest.self, from: body) else {
                fail("INPUT_ERROR", "process-argv needs one bounded JSON request on stdin")
            }
            emit(["status": argvStatus(request)])
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
