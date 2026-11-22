// Read and select macOS text input sources through the Carbon TIS API.
//
// The helper only lists sources, reports the current one and selects one by ID;
// it never types, opens a window or asks for Accessibility/Input Monitoring.
// Every command prints one JSON envelope: { ok: true, data } or
// { ok: false, error: { code, message } }.
import Foundation
import Carbon
import CoreFoundation

struct HelperFailure: Error {
  let code: String
  let message: String
}

func propertyString(_ source: TISInputSource, _ key: CFString) -> String? {
  guard let value = TISGetInputSourceProperty(source, key) else { return nil }
  return unsafeBitCast(value, to: CFString.self) as String
}

func propertyBool(_ source: TISInputSource, _ key: CFString) -> Bool {
  guard let value = TISGetInputSourceProperty(source, key) else { return false }
  return CFBooleanGetValue(unsafeBitCast(value, to: CFBoolean.self))
}

func describe(_ source: TISInputSource) -> [String: Any]? {
  guard let id = propertyString(source, kTISPropertyInputSourceID) else { return nil }
  return [
    "id": id,
    "name": propertyString(source, kTISPropertyLocalizedName) ?? id,
    "ascii": propertyBool(source, kTISPropertyInputSourceIsASCIICapable),
    "selectable": propertyBool(source, kTISPropertyInputSourceIsSelectCapable),
  ]
}

/// Only enabled sources can be selected; disabled ones are not user choices.
func enabledSources() -> [TISInputSource] {
  guard let list = TISCreateInputSourceList(nil, false)?.takeRetainedValue() as? [TISInputSource] else {
    return []
  }
  return list
}

func currentSource() -> TISInputSource? {
  guard let source = TISCopyCurrentKeyboardInputSource() else { return nil }
  return source.takeRetainedValue()
}

func findSource(_ id: String) -> TISInputSource? {
  enabledSources().first { propertyString($0, kTISPropertyInputSourceID) == id }
}

func option(_ args: [String], _ name: String) -> String? {
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func emit(_ data: Any) {
  let payload: [String: Any] = ["ok": true, "data": data]
  write(payload, code: 0)
}

func fail(_ code: String, _ message: String) -> Never {
  write(["ok": false, "error": ["code": code, "message": message]], code: 1)
}

func write(_ object: [String: Any], code: Int32) -> Never {
  guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
    FileHandle.standardError.write(Data("cuekeeper-ime: could not encode the response\n".utf8))
    exit(2)
  }
  FileHandle.standardOutput.write(bytes)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(code)
}

@main
struct InputSourceHelper {
  static func main() {
    let args = Array(CommandLine.arguments.dropFirst())
    guard let command = args.first else {
      fail("INPUT_ERROR", "usage: cuekeeper-ime version|list|current|select --id <id>")
    }

    switch command {
    case "version":
      emit(["helper": "cuekeeper-ime", "version": 1])
    case "list":
      emit(["sources": enabledSources().compactMap(describe)])
    case "current":
      guard let source = currentSource(), let data = describe(source) else {
        fail("IME_SOURCE_UNAVAILABLE", "Could not read the current input source")
      }
      emit(["source": data])
    case "select":
      guard let id = option(args, "--id"), !id.isEmpty else {
        fail("INPUT_ERROR", "select requires --id <input-source-id>")
      }
      guard let source = findSource(id) else {
        fail("IME_SOURCE_UNAVAILABLE", "No enabled input source has ID \(id)")
      }
      guard propertyBool(source, kTISPropertyInputSourceIsSelectCapable) else {
        fail("IME_SOURCE_UNAVAILABLE", "Input source \(id) cannot be selected")
      }
      let status = TISSelectInputSource(source)
      if status != 0 {
        fail("IME_SELECT_FAILED", "TISSelectInputSource returned \(status)")
      }
      guard let selected = currentSource(), let data = describe(selected) else {
        fail("IME_RESTORE_FAILED", "Input source was selected but the current source cannot be read back")
      }
      let currentId = data["id"] as? String ?? ""
      if currentId != id {
        fail("IME_SELECT_FAILED", "Requested \(id) but the current source is \(currentId)")
      }
      emit(["selected": data])
    default:
      fail("INPUT_ERROR", "Unknown command \(command)")
    }
  }
}
