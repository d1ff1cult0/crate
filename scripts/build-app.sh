#!/bin/bash
# Builds dist/Crate.app from the Swift package (no Xcode project needed).
#   scripts/build-app.sh                  release, universal
#   UNIVERSAL=0 scripts/build-app.sh      release, arm64 only (faster)
#   VARIANT=dev scripts/build-app.sh      dist/Crate Dev.app: own bundle id, data folders,
#                                         preferences and crate-dev:// scheme, for testing
#                                         next to the installed app
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(cat VERSION 2>/dev/null || echo 1.0.0)"
BUILD="$(git rev-list --count HEAD 2>/dev/null || echo 1)"
CONFIG="${CONFIG:-release}"
VARIANT="${VARIANT:-release}"

if [[ "$VARIANT" == "dev" ]]; then
    NAME="Crate Dev"
    BUNDLE_ID="com.jplessers.crate.dev"
    SCHEME="crate-dev"
else
    NAME="Crate"
    BUNDLE_ID="com.jplessers.crate"
    SCHEME="crate"
fi
APP="dist/$NAME.app"

if [[ ! -f Resources/AppIcon.icns ]]; then
    swift scripts/make-icon.swift Resources/AppIcon.icns
fi

echo "Building $NAME $VERSION (${BUILD}), ${CONFIG}…"
swift build -c "$CONFIG" --arch arm64
BIN_ARM="$(swift build -c "$CONFIG" --arch arm64 --show-bin-path)/Crate"

# Universal binary when the x86_64 slice builds (it does with the Command Line Tools SDK).
BINARY="$BIN_ARM"
if [[ "${UNIVERSAL:-1}" == "1" ]] && swift build -c "$CONFIG" --arch x86_64 >/dev/null 2>&1; then
    BIN_X86="$(swift build -c "$CONFIG" --arch x86_64 --show-bin-path)/Crate"
    mkdir -p .build/universal
    lipo -create "$BIN_ARM" "$BIN_X86" -output .build/universal/Crate
    BINARY=".build/universal/Crate"
    echo "Universal binary (arm64 + x86_64)"
else
    echo "arm64 binary"
fi

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/Fonts"
cp "$BINARY" "$APP/Contents/MacOS/Crate"
cp Resources/Fonts/*.ttf Resources/Fonts/LICENSE-*.txt "$APP/Contents/Resources/Fonts/"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
sed -e "s/__VERSION__/$VERSION/" -e "s/__BUILD__/$BUILD/" \
    -e "s/com\.jplessers\.crate/$BUNDLE_ID/g" \
    -e "s/<string>crate<\/string>/<string>$SCHEME<\/string>/" \
    -e "s/<string>Crate<\/string>/<string>$NAME<\/string>/g" \
    Resources/Info.plist > "$APP/Contents/Info.plist"
# The executable keeps its name in both variants.
/usr/libexec/PlistBuddy -c "Set :CFBundleExecutable Crate" "$APP/Contents/Info.plist"
printf "APPL????" > "$APP/Contents/PkgInfo"

# Ad-hoc signature: enough to run locally. Secrets are kept outside the keychain (see
# Sources/Crate/App/Secrets.swift) because keychain access is tied to the exact build.
codesign --force --deep --sign - "$APP"
echo "Built $APP"
