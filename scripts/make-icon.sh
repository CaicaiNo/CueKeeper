#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
swift scripts/make-icon.swift

cd desktop/icons
rm -rf AppIcon.iconset
mkdir AppIcon.iconset
sips -z 16 16 icon.png --out AppIcon.iconset/icon_16x16.png >/dev/null
sips -z 32 32 icon.png --out AppIcon.iconset/icon_16x16@2x.png >/dev/null
sips -z 32 32 icon.png --out AppIcon.iconset/icon_32x32.png >/dev/null
sips -z 64 64 icon.png --out AppIcon.iconset/icon_32x32@2x.png >/dev/null
sips -z 128 128 icon.png --out AppIcon.iconset/icon_128x128.png >/dev/null
sips -z 256 256 icon.png --out AppIcon.iconset/icon_128x128@2x.png >/dev/null
sips -z 256 256 icon.png --out AppIcon.iconset/icon_256x256.png >/dev/null
sips -z 512 512 icon.png --out AppIcon.iconset/icon_256x256@2x.png >/dev/null
sips -z 512 512 icon.png --out AppIcon.iconset/icon_512x512.png >/dev/null
sips -z 1024 1024 icon.png --out AppIcon.iconset/icon_512x512@2x.png >/dev/null
iconutil -c icns AppIcon.iconset -o icon.icns
rm -rf AppIcon.iconset
printf 'icon: %s\n' "$(pwd)/icon.icns"
