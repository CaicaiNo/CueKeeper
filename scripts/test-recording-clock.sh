#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/clock-tests" ]; then unlink "$build_dir/clock-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-clock.swift test/recording-clock-tests.swift -o "$build_dir/clock-tests"
"$build_dir/clock-tests"
