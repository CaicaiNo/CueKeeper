#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/hotkey-tests" ]; then unlink "$build_dir/hotkey-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-hotkeys.swift test/recording-hotkeys-tests.swift -o "$build_dir/hotkey-tests"
"$build_dir/hotkey-tests"
