# Konnect. `make` on its own lists the targets.
BIN  := node_modules/.bin
ARGS ?=

.DEFAULT_GOAL := help
.PHONY: help dev mock test dist clean

help:  ## list targets
	@grep -hE '^[a-z_%-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/|/' | column -ts'|'

node_modules: package-lock.json  ## install dependencies (runs itself when the lockfile moves)
	npm install
	@touch $@

dev: node_modules  ## run the app against the real handset
	npm start

mock: node_modules  ## run the app against the mock backend, no handset needed
	KONNECT_MOCK=1 npm start

test: node_modules  ## run the unit tests
	npm test

verify-%: node_modules  ## manual hardware probe: make verify-telephony ARGS=+919876543210
	node scripts/verify-$*.js $(ARGS)

dist: node_modules  ## build the AppImage and .deb into dist/ (ARGS="--publish always" to upload)
	$(BIN)/electron-builder --linux $(ARGS)

clean:  ## delete build output
	rm -rf dist
