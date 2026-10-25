.PHONY: build app dmg run test icon clean

build:            ## Debug build
	swift build

app:              ## dist/Crate.app (release, universal)
	scripts/build-app.sh

dmg: app          ## dist/Crate-<version>.dmg
	scripts/make-dmg.sh

run:              ## Build a fast arm64 app bundle and open it
	UNIVERSAL=0 scripts/build-app.sh && open dist/Crate.app

test:             ## Unit tests (Swift Testing)
	scripts/test.sh

icon:             ## Redraw Resources/AppIcon.icns
	swift scripts/make-icon.swift Resources/AppIcon.icns

clean:
	rm -rf .build dist
