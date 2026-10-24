.PHONY: install package reinstall link-plugin unlink-plugin

# Suppresses Node's DEP0169 warning emitted by the `code` CLI
export NODE_OPTIONS := --no-deprecation

VSIX := $(CURDIR)/$(shell node -p "require('./package.json').name + '-' + require('./package.json').version").vsix

install:
	@test -f "$(VSIX)" || { echo "$(VSIX) not found; run 'make package' first" >&2; exit 1; }
	code --install-extension "$(VSIX)" --force

package:
	npm run package

reinstall:
	$(MAKE) package
	$(MAKE) install

# Registers the plugin globally in herdr; unlink when done testing
link-plugin:
	herdr plugin link "$(CURDIR)/plugin"

unlink-plugin:
	herdr plugin unlink zenderx.herdr-navigator
	@echo "Note: the plugin's saved record stays in %LOCALAPPDATA%\herdr\plugins\zenderx.herdr-navigator"
	@echo "Note: so do its cwd-<session>.txt, cwd-track-<session>.pid and cwd-track-<session>.err files; a running cwd-track exits once its server stops"
