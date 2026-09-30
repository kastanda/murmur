#!/bin/bash
# Build Murmur.app from the command line. No Xcode project, no clicking.
#
# The result is an unsigned, ad-hoc-signed bundle for local use. It is not notarized and
# is not meant for distribution — this is the developer/personal install path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIGURATION="${CONFIGURATION:-release}"
BUILD_DIR="$HERE/.build/bundle"
APP="$BUILD_DIR/Murmur.app"
VERSION="$(node -p "require('$HERE/../../package.json').version" 2>/dev/null || echo "0.0.0")"

echo "==> swift build ($CONFIGURATION)"
swift build --package-path "$HERE" -c "$CONFIGURATION"
BIN="$(swift build --package-path "$HERE" -c "$CONFIGURATION" --show-bin-path)/MurmurMenuBar"
[ -x "$BIN" ] || { echo "build produced no executable at $BIN" >&2; exit 1; }

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/MurmurMenuBar"
sed "s/__VERSION__/$VERSION/g" "$HERE/Resources/Info.plist" > "$APP/Contents/Info.plist"

# Ad-hoc signature. Without one, macOS refuses to keep the status item alive across
# relaunches on recent systems.
codesign --force --sign - --identifier dev.murmur.menubar "$APP" >/dev/null
codesign --verify --deep --strict "$APP"

echo "built $APP (version $VERSION)"
