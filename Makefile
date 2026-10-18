.PHONY: install package reinstall

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
