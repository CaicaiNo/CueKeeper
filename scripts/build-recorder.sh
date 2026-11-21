#!/bin/sh
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "The M1 recorder requires macOS" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
mkdir -p dist
swiftc -O -parse-as-library native/app-identity.swift -o dist/cuekeeper-identity
swiftc -O -parse-as-library native/recorder.swift native/recording-indicator.swift \
  native/recording-hotkeys.swift native/recording-pointer.swift -o dist/cuekeeper-capture
# Window-level ScreenCaptureKit filters need macOS 13; this helper has its own
# TCC identity so rebuilding the input recorder never drops screen recording.
swiftc -O -parse-as-library -target arm64-apple-macos13.0 native/video-capture.swift \
  -o dist/cuekeeper-video
