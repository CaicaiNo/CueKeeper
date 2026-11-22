#!/bin/sh
# Build the M1 recorder helpers.
#
#   build-recorder.sh             # identity + input recorder + video helper
#   build-recorder.sh --video     # only dist/cuekeeper-video
#
# The video helper has its own TCC identity, so rebuilding it must not touch the
# input recorder (and vice versa). `--video` is the explicit entry for that.
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "The M1 recorder requires macOS" >&2; exit 2 ;;
esac
target=all
case "${1:-}" in
  ""|--all) target=all ;;
  --video) target=video ;;
  *) echo "usage: $0 [--all|--video]" >&2; exit 2 ;;
esac
if [ "$#" -gt 1 ]; then
  echo "usage: $0 [--all|--video]" >&2
  exit 2
fi
cd "$(dirname "$0")/.."
mkdir -p dist
if [ "$target" = all ]; then
  swiftc -O -parse-as-library native/app-identity.swift -o dist/cuekeeper-identity
  swiftc -O -parse-as-library native/recorder.swift native/recording-indicator.swift \
    native/recording-hotkeys.swift native/recording-pointer.swift -o dist/cuekeeper-capture
fi
# Window-level ScreenCaptureKit filters need macOS 13; this helper has its own
# TCC identity so rebuilding the input recorder never drops screen recording.
swiftc -O -parse-as-library -target arm64-apple-macos13.0 native/video-capture.swift \
  -o dist/cuekeeper-video
