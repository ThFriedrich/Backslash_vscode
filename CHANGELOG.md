# Changelog

All notable changes to **Backslash Sync** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2025-02-14

### Added

- **Compile & Preview** workflow: push the workspace, trigger a server-side
  build, and open the PDF in one command (`Ctrl+Alt+B`).
- **Rich PDF viewer** built on PDF.js with zoom, fit-to-width/page, and page
  navigation (`Ctrl+Alt+V`). The PDF renders from a temp file and never
  pollutes the workspace.
- **Build on save**: automatically compile and refresh the preview when a
  `.tex` file is saved (`backslash.buildOnSave`).
- **Project Files** activity-bar view: browse, open, upload, and delete files
  on the server.
- **Offline mode** (`backslash.offlineMode`) with git-style manual sync:
  Download Project (Clone), Sync → Push, Sync ← Pull, Show Sync Status, and
  conflict resolution (keep local / take server / open diff). Sync state is
  tracked in `.backslash/manifest.json` using SHA-256 content hashes.
- Server API key stored securely in VS Code SecretStorage.
- Project selection linked per-workspace via `backslash.projectId`.
- Configurable LaTeX engine (`auto`/`pdflatex`/`xelatex`/`lualatex`/`latex`),
  push include/exclude globs, and auto-open-PDF behavior.
- Editor-title buttons and keybindings for Compile & Preview and View PDF.

### Notes

- Binary assets are skipped during manual sync because content is transferred
  through the server's text API.

[Unreleased]: https://github.com/your-org/backslash-vscode/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/your-org/backslash-vscode/releases/tag/v0.1.0
