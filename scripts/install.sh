#!/bin/bash
# Installs dist/Crate.app into /Applications, quitting and reopening a running copy.
# The library cache, downloads, settings and secrets live outside the app bundle, so they
# carry over untouched.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d dist/Crate.app ]] || scripts/build-app.sh
TARGET="/Applications/Crate.app"

WAS_RUNNING=0
if pgrep -xf "$TARGET/Contents/MacOS/Crate" >/dev/null; then
    WAS_RUNNING=1
    osascript -e 'tell application id "com.jplessers.crate" to quit' >/dev/null 2>&1 || true
    for _ in $(seq 1 50); do
        pgrep -xf "$TARGET/Contents/MacOS/Crate" >/dev/null || break
        sleep 0.2
    done
fi

rm -rf "$TARGET.new"
ditto dist/Crate.app "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new" "$TARGET"
echo "Installed $(defaults read "$TARGET/Contents/Info" CFBundleShortVersionString) to $TARGET"
if [[ "$WAS_RUNNING" == "1" ]]; then open "$TARGET"; fi
