# Verifying a release

Each release from the version after v0.1.3 onward is built by a GitHub Actions workflow ([`release.yml`](../.github/workflows/release.yml)) from the tagged source. The workflow attaches the VSIX to the GitHub Release together with a signed build provenance attestation. You can check that the file you run is the one that workflow built, and that its code matches the source.

Replace `X.Y.Z` below with the version you are checking.

## 1. Verify the attestation

Download `herdr-navigator-X.Y.Z.vsix` from the [GitHub Releases](https://github.com/ZenderX/herdr-vscode-navigator/releases) page, then run:

```sh
gh attestation verify herdr-navigator-X.Y.Z.vsix --repo ZenderX/herdr-vscode-navigator --signer-workflow ZenderX/herdr-vscode-navigator/.github/workflows/release.yml --source-ref refs/tags/vX.Y.Z
```

This needs the [GitHub CLI](https://cli.github.com/). A pass proves the file was signed by `release.yml` in this repository, in a run for the `vX.Y.Z` tag, and has not changed since. The `--signer-workflow` and `--source-ref` flags are what enforce this; without them, a file attested by any workflow or tag in the repository would pass. The release also has a `.sha256` file for a plain checksum comparison.

## 2. Compare the installed extension

A VSIX is a zip file. Extract it, then compare its `out/` folder with the installed copy:

```sh
unzip herdr-navigator-X.Y.Z.vsix -d vsix
diff -r vsix/extension/out ~/.vscode/extensions/z3nder.herdr-navigator-X.Y.Z/out
```

On Windows the extensions folder is `%USERPROFILE%\.vscode\extensions\z3nder.herdr-navigator-X.Y.Z\out`. Compare `out/` only: VS Code may add its own metadata files elsewhere in the installed folder. No output means the installed code is identical to the attested file.

## 3. Rebuild from source

```sh
git clone -c core.autocrlf=false --branch vX.Y.Z --depth 1 https://github.com/ZenderX/herdr-vscode-navigator.git
cd herdr-vscode-navigator
npm ci && npm run compile
diff -r --strip-trailing-cr -x test -x '*.map' out ../vsix/extension/out
```

The `-c core.autocrlf=false` matters on Windows: Git for Windows otherwise checks out CRLF source files, and the compiler copies those line endings into multi-line strings in the output (for example in `out/vscode/anchor.js`), so the rebuild differs from the release. If you already cloned with CRLF, `--strip-trailing-cr` in the `diff` above covers it.

## Limits

- The VSIX zip itself is not byte-for-byte reproducible, because zip entries carry timestamps. Compare contents, not the archive hash of a rebuild.
- v0.1.3 and earlier were built locally before this workflow existed. They have no attestation, and their `out/` files use CRLF line endings. They have no GitHub Release, so step 1 does not apply and there is no release VSIX for step 3. Compare a rebuild of that tag against the installed `~/.vscode/extensions/z3nder.herdr-navigator-X.Y.Z/out`, or against a VSIX downloaded from the Marketplace listing and unzipped as in step 2: `diff -r --strip-trailing-cr -x test -x '*.map' out ~/.vscode/extensions/z3nder.herdr-navigator-X.Y.Z/out` (or `... out ../vsix/extension/out`).
- The GitHub Release is the verifiable copy. This page makes no claim that the Marketplace serves a byte-identical file.
