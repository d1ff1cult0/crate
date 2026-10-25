#!/bin/bash
# Runs the unit tests. With only the Command Line Tools installed, Swift Testing lives in
# a framework directory SwiftPM doesn't search, and SwiftPM's generated test runner must
# see it too (otherwise `swift test` builds and silently runs nothing).
set -euo pipefail
cd "$(dirname "$0")/.."
FRAMEWORKS="/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
if [[ -d "$FRAMEWORKS/Testing.framework" ]] && ! xcode-select -p | grep -q Xcode.app; then
    exec swift test -Xswiftc -F -Xswiftc "$FRAMEWORKS" -Xlinker -F -Xlinker "$FRAMEWORKS" -Xlinker -rpath -Xlinker "$FRAMEWORKS" "$@"
fi
exec swift test "$@"
