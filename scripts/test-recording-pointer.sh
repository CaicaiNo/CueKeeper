#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/pointer-tests" ]; then unlink "$build_dir/pointer-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-pointer.swift test/recording-pointer-tests.swift -o "$build_dir/pointer-tests"
"$build_dir/pointer-tests" "$@"
