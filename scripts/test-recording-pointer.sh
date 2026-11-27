#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# A hover step's coordinates may only come from HoverRecorder; a call site that
# builds its own HoverEmission could reintroduce the mirrored AppKit point.
if grep -n "HoverEmission(" native/recorder.swift; then
  echo "native/recorder.swift must take hover coordinates from HoverRecorder" >&2
  exit 1
fi
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/pointer-tests" ]; then unlink "$build_dir/pointer-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-pointer.swift native/pointer-identity.swift \
  test/recording-pointer-tests.swift -o "$build_dir/pointer-tests"
"$build_dir/pointer-tests" "$@"
