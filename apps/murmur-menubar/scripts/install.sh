#!/bin/bash
# Install Murmur.app into ~/Applications — a USER-LOCAL install, so it never needs sudo
# and never touches a system directory.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="$HERE/.build/bundle/Murmur.app"
DEST="${MURMUR_APP_DEST:-$HOME/Applications}"

[ -d "$APP" ] || "$HERE/scripts/build.sh"

mkdir -p "$DEST"
# A running copy cannot be replaced in place. This asks THAT app to quit by name; it is a
# no-op when nothing is running, and it is deliberately not a pattern-matched process kill.
osascript -e 'tell application "Murmur" to quit' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST/Murmur.app"
cp -R "$APP" "$DEST/Murmur.app"
echo "installed $DEST/Murmur.app"
echo "open it with:  open '$DEST/Murmur.app'"
