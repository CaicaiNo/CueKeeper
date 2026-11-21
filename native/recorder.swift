import AppKit
import Carbon
import CoreGraphics
import Foundation

// The listener is opt-in and never modifies or suppresses an input event.
final class Capture {
    let app: String
    let started = DispatchTime.now().uptimeNanoseconds
    var failed = false
    var active = false
    var events = 0

    init(app: String) {
        self.app = app
    }

    func emit(_ object: [String: Any]) {
        do {
            var line = try JSONSerialization.data(withJSONObject: object)
            line.append(0x0A)
            try FileHandle.standardOutput.write(contentsOf: line)
        } catch {
            failed = true
            CFRunLoopStop(CFRunLoopGetCurrent())
        }
    }

    func stop(_ code: String) {
        failed = true
        emit(["kind": "error", "code": code])
        CFRunLoopStop(CFRunLoopGetCurrent())
    }

    func receive(_ type: CGEventType, _ event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            stop("TAP_DISABLED")
            return
        }
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == app else {
            if active { stop("FOCUS_CHANGED") }
            return
        }
        if IsSecureEventInputEnabled() {
            stop("SECURE_INPUT")
            return
        }
        if type == .keyDown && event.getIntegerValueField(.keyboardEventAutorepeat) != 0 {
            stop("KEY_REPEAT")
            return
        }

        active = true
        events += 1
        guard events <= 1000 else { stop("EVENT_LIMIT"); return }
        let t = (DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
        let seen = Int(Date().timeIntervalSince1970 * 1000)
        if type == .leftMouseDown {
            let location = event.location
            let modifiers = event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift])
            guard modifiers.isEmpty && event.getIntegerValueField(.mouseEventClickState) == 1 else {
                stop("UNSUPPORTED_CLICK")
                return
            }
            emit(["kind": "click", "point": [Int(location.x.rounded()), Int(location.y.rounded())],
                  "t": t, "seen": seen])
            return
        }
        guard type == .keyDown else { stop("UNSUPPORTED_EVENT"); return }

        let flags: [(CGEventFlags, String)] = [
            (.maskCommand, "meta"), (.maskControl, "ctrl"), (.maskAlternate, "alt"), (.maskShift, "shift")
        ]
        let modifiers = flags.compactMap { flag, name in event.flags.contains(flag) ? name : nil }
        let code = Int(event.getIntegerValueField(.keyboardEventKeycode))
        let special = namedKeys[code]
        if special == nil || special == "space" {
            if modifiers.isEmpty || modifiers == ["shift"] {
                var buffer = [UniChar](repeating: 0, count: 16)
                var length = 0
                event.keyboardGetUnicodeString(maxStringLength: buffer.count,
                                             actualStringLength: &length, unicodeString: &buffer)
                if length > 0 && length <= buffer.count {
                    let chars = String(decoding: buffer.prefix(length), as: UTF16.self)
                    if chars.unicodeScalars.allSatisfy({ $0.value >= 32 && $0.value <= 126 }) {
                        emit(["kind": "text", "chars": chars, "t": t, "seen": seen])
                        return
                    }
                }
                stop("UNSUPPORTED_TEXT")
                return
            }
        }
        guard let key = special ?? ansiKeys[code] else { stop("UNSUPPORTED_KEY"); return }
        emit(["kind": "key", "key": key, "modifiers": modifiers, "t": t, "seen": seen])
    }
}

// ANSI virtual key codes are used only for physical shortcut keys. Printable
// text comes from the event's Unicode payload and preserves capitalization.
let ansiKeys: [Int: String] = [
    0:"a", 1:"s", 2:"d", 3:"f", 4:"h", 5:"g", 6:"z", 7:"x", 8:"c", 9:"v",
    11:"b", 12:"q", 13:"w", 14:"e", 15:"r", 16:"y", 17:"t", 18:"1", 19:"2",
    20:"3", 21:"4", 22:"6", 23:"5", 25:"9", 26:"7", 28:"8", 29:"0", 31:"o",
    32:"u", 34:"i", 35:"p", 37:"l", 38:"j", 40:"k", 45:"n", 46:"m"
]
let namedKeys: [Int: String] = [
    36:"return", 48:"tab", 49:"space", 51:"backspace", 53:"escape",
    96:"f5", 97:"f6", 98:"f7", 99:"f3", 100:"f8", 101:"f9", 103:"f11", 109:"f10",
    111:"f12", 115:"home", 116:"pageup", 117:"forwarddelete", 118:"f4", 119:"end",
    120:"f2", 121:"pagedown", 122:"f1", 123:"left", 124:"right", 125:"down", 126:"up"
]

guard CommandLine.arguments.count == 3,
      let seconds = Double(CommandLine.arguments[2]), (1...60).contains(seconds) else {
    exit(2)
}
let capture = Capture(app: CommandLine.arguments[1])
guard CGPreflightListenEventAccess() else {
    capture.emit(["kind": "error", "code": "INPUT_MONITORING_REQUIRED"])
    exit(2)
}
let observedTypes: [CGEventType] = [.leftMouseDown, .rightMouseDown, .otherMouseDown,
                                    .leftMouseDragged, .keyDown, .scrollWheel]
let mask = observedTypes.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
let context = Unmanaged.passUnretained(capture).toOpaque()
guard let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
    eventsOfInterest: mask, callback: { _, type, event, context in
        if let context {
            Unmanaged<Capture>.fromOpaque(context).takeUnretainedValue().receive(type, event)
        }
        return Unmanaged.passUnretained(event)
    }, userInfo: context
), let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
    capture.emit(["kind": "error", "code": "TAP_UNAVAILABLE"])
    exit(2)
}
let loop = CFRunLoopGetCurrent()
CFRunLoopAddSource(loop, source, .commonModes)
CGEvent.tapEnable(tap: tap, enable: true)
capture.emit(["kind": "ready"])
CFRunLoopRunInMode(.defaultMode, seconds, false)
CGEvent.tapEnable(tap: tap, enable: false)
CFRunLoopRemoveSource(loop, source, .commonModes)
CFMachPortInvalidate(tap)
exit(capture.failed ? 1 : 0)
