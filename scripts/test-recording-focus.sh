#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/focus-tests" ]; then unlink "$build_dir/focus-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/focus-evidence.swift test/recording-focus-tests.swift -o "$build_dir/focus-tests"
"$build_dir/focus-tests"
