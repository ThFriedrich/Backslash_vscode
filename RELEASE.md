# Releasing Backslash Sync

This document describes how to build, package, and publish the extension.

## Prerequisites

- **Node.js 18+** and npm.
- **[@vscode/vsce](https://github.com/microsoft/vscode-vsce)** — installed as a
  dev dependency (`npm install`), so you can run it via `npx vsce` or the
  `npm run vsix` script.
- A **publisher** on the [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage)
  and an **Azure DevOps Personal Access Token (PAT)** with the *Marketplace →
  Manage* scope. See the
  [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).

## Before you release

1. Update the version in [`package.json`](package.json) following
   [SemVer](https://semver.org/).
2. Move the relevant notes from `Unreleased` into a new dated section in
   [`CHANGELOG.md`](CHANGELOG.md).
3. Replace the placeholder `publisher` (`"local"`) in `package.json` with your
   real Marketplace publisher ID, and update the `repository`, `bugs`, and
   `homepage` URLs.
4. Consider adding an `icon` (128×128 PNG) to `package.json` for the
   Marketplace listing.

## Build & package

The extension is bundled with webpack. `vsce` runs the `vscode:prepublish`
script automatically, which produces `dist/extension.js`.

```bash
npm install          # install the build toolchain
npm run package      # production webpack build → dist/extension.js
npm run vsix         # create backslash-vscode-<version>.vsix
```

Verify the packaged contents:

```bash
npx vsce ls          # list files that will be included in the VSIX
```

The VSIX **must** contain `dist/extension.js` and the `media/` assets
(`pdfViewer.html`, `pdfViewer.js`, `pdfjs/*.mjs`) and **must not** contain
`src/`, `node_modules/`, or source maps. Ignore rules live in
[`.vscodeignore`](.vscodeignore).

## Install locally (side-load)

```bash
code --install-extension backslash-vscode-<version>.vsix
```

## Publish to the Marketplace

```bash
# one-time: sign in with your PAT
npx vsce login <publisher>

# publish the current version
npx vsce publish

# or bump + publish in one step
npx vsce publish minor
```

## Tag the release

```bash
git tag v<version>
git push origin v<version>
```
