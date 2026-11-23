#!/bin/sh
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "The M1 recorder requires macOS" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
mkdir -p dist
swiftc -O -parse-as-library native/app-identity.swift -o dist/cuekeeper-identity
swiftc -O -parse-as-library native/input-source.swift -o dist/cuekeeper-ime
swiftc -O -parse-as-library native/recorder.swift native/recording-indicator.swift \
  native/recording-hotkeys.swift native/recording-pointer.swift native/pointer-identity.swift \
  native/focus-evidence.swift \
  native/recording-clock.swift \
  -o dist/cuekeeper-capture
