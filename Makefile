.PHONY: build app dmg run dev install release test icon clean

build:            ## Debug build
	swift build

app:              ## dist/Crate.app (release, universal)
	scripts/build-app.sh

dmg: app          ## dist/Crate-<version>.dmg
	scripts/make-dmg.sh

run:              ## Build a fast arm64 app bundle and open it
	UNIVERSAL=0 scripts/build-app.sh && open dist/Crate.app

dev:              ## "Crate Dev" (own data, settings and crate-dev:// scheme), next to the installed app
	VARIANT=dev UNIVERSAL=0 scripts/build-app.sh && open "dist/Crate Dev.app"

install:          ## Build and install into /Applications (reopens a running copy)
	scripts/build-app.sh && scripts/install.sh

release:          ## Publish VERSION as a GitHub release for the in-app updater
	scripts/release.sh

test:             ## Unit tests (Swift Testing)
	scripts/test.sh

icon:             ## Redraw Resources/AppIcon.icns
	swift scripts/make-icon.swift Resources/AppIcon.icns

clean:
	rm -rf .build dist
