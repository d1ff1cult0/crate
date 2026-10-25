#!/bin/bash
# Packages dist/Crate.app into dist/Crate-<version>.dmg with an Applications shortcut.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(cat VERSION 2>/dev/null || echo 1.0.0)"
APP="dist/Crate.app"
DMG="dist/Crate-$VERSION.dmg"
[[ -d "$APP" ]] || scripts/build-app.sh

STAGING="$(mktemp -d)/Crate"
mkdir -p "$STAGING/.background"
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
swift scripts/make-dmg-background.swift "$STAGING/.background/background.png" >/dev/null

rm -f "$DMG" dist/Crate-rw.dmg
hdiutil create -volname "Crate" -srcfolder "$STAGING" -fs HFS+ -format UDRW -ov dist/Crate-rw.dmg >/dev/null

# Lay out the window (icon positions, background) through Finder. If Finder automation
# isn't allowed, the DMG still works, just without the layout.
DEVICE="$(hdiutil attach -readwrite -noverify -noautoopen dist/Crate-rw.dmg | awk '/Apple_HFS/ {print $1; exit}')"
MOUNT="/Volumes/Crate"
sleep 1
if [[ "${DMG_LAYOUT:-1}" == "1" ]]; then
    timeout_cmd() { perl -e 'alarm shift; exec @ARGV' "$@"; }
    timeout_cmd 30 osascript <<'APPLESCRIPT' || echo "Skipped Finder layout"
tell application "Finder"
    tell disk "Crate"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {200, 120, 860, 520}
        set opts to the icon view options of container window
        set arrangement of opts to not arranged
        set icon size of opts to 112
        set text size of opts to 13
        set background picture of opts to file ".background:background.png"
        set position of item "Crate.app" of container window to {170, 190}
        set position of item "Applications" of container window to {490, 190}
        close
        open
        update without registering applications
        delay 1
        close
    end tell
end tell
APPLESCRIPT
fi
chmod -Rf go-w "$MOUNT" 2>/dev/null || true
sync
hdiutil detach "$DEVICE" -quiet || hdiutil detach "$DEVICE" -force -quiet
hdiutil convert dist/Crate-rw.dmg -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null
rm -f dist/Crate-rw.dmg
echo "Built $DMG"
