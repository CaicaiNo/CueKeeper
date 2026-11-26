#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/label-tests" ]; then unlink "$build_dir/label-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-label.swift test/recording-label-tests.swift -o "$build_dir/label-tests"
"$build_dir/label-tests"
