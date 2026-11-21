#!/bin/sh
# Offline self-test for the session-video helper.
#
# It compiles native/video-capture.swift and encodes synthetic frames with
# AVAssetWriter. It never starts ScreenCaptureKit, never captures a window and
# never asks for a TCC permission, so it is safe to run unattended.
set -eu
case "$(uname -s)" in
  Darwin) ;;
  *) echo "The video encoder self-test requires macOS" >&2; exit 2 ;;
esac
cd "$(dirname "$0")/.."
mkdir -p dist
swiftc -O -parse-as-library -target arm64-apple-macos13.0 native/video-capture.swift \
  -o dist/cuekeeper-video
exec ./dist/cuekeeper-video --self-test
