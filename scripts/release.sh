#!/bin/bash
# Publishes a GitHub release (zip + dmg). Installed copies of Crate find it through
# Settings → Updates (and check automatically), so nobody has to reinstall by hand.
#   1. bump VERSION and commit
#   2. scripts/release.sh            (NOTES_FILE=notes.md for custom release notes)
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION="$(cat VERSION)"
TAG="v$VERSION"

if gh release view "$TAG" >/dev/null 2>&1; then
    echo "Release $TAG already exists. Bump VERSION first." >&2
    exit 1
fi
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Commit your changes first; the release is cut from the current commit." >&2
    exit 1
fi

scripts/build-app.sh
rm -f "dist/Crate-$VERSION.zip"
# The updater downloads this zip; ditto keeps the bundle's symlinks and signature intact.
ditto -c -k --keepParent dist/Crate.app "dist/Crate-$VERSION.zip"
scripts/make-dmg.sh

NOTES=(--generate-notes)
if [[ -n "${NOTES_FILE:-}" && -f "$NOTES_FILE" ]]; then NOTES=(--notes-file "$NOTES_FILE"); fi
git push origin HEAD
gh release create "$TAG" "dist/Crate-$VERSION.zip" "dist/Crate-$VERSION.dmg" \
    --title "Crate $VERSION" --target "$(git rev-parse HEAD)" "${NOTES[@]}"
