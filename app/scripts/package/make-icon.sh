#!/bin/sh
# Builds app/build/icon.icns from a square PNG (default: the product's iOS app icon in the frontend
# repo). Run from the repo root: sh app/scripts/package/make-icon.sh [source.png]
# System tools only (swift, iconutil). Writes app/build/icon.icns and app/build/icon-preview.png.
set -eu
APP="$(cd "$(dirname "$0")/../.." && pwd)"
SRC="${1:-$HOME/techcells/clave-front/apps/mobile/assets/appicon-ios-1024.png}"
OUT="$APP/build"
SET="$OUT/icon.iconset"
[ -f "$SRC" ] || { echo "MAKE_ICON_FAILED SOURCE_MISSING $SRC" >&2; exit 1; }
rm -rf "$SET"; mkdir -p "$OUT"
swift "$APP/scripts/package/make-icon.swift" "$SRC" "$SET"
/usr/bin/iconutil -c icns "$SET" -o "$OUT/icon.icns"
cp "$SET/icon_256x256.png" "$OUT/icon-preview.png"
rm -rf "$SET"
echo "MAKE_ICON_OK $OUT/icon.icns"
