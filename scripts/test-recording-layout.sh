#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
build_dir=$(mktemp -d)
trap 'if [ -e "$build_dir/layout-tests" ]; then unlink "$build_dir/layout-tests"; fi; rmdir "$build_dir"' EXIT
swiftc -parse-as-library native/recording-indicator.swift native/recording-label.swift \
  test/recording-hud-layout-tests.swift -o "$build_dir/layout-tests"
"$build_dir/layout-tests"
