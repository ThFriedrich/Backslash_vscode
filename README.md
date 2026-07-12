# Backslash Sync

Edit LaTeX locally in VS Code and drive a **self-hosted [Backslash](https://backslash.dev) server** over its REST API — push your sources, compile them server-side, and preview the resulting PDF in a rich, built-in viewer. No local TeX installation required.

## Features

- **Compile & Preview** — push the workspace, trigger a server-side build, and open the PDF in one action (`Ctrl+Alt+B`).
- **Rich PDF viewer** — a PDF.js-based preview with zoom, fit-to-width/page, and page navigation (`Ctrl+Alt+V`). The PDF is rendered from a temp file, so it never pollutes your workspace.
- **Build on save** — automatically compile and refresh the preview whenever you save a `.tex` file (toggleable).
- **Project Files view** — an activity-bar panel that lists the files on the server; open, upload, or delete remote files directly.
- **Offline mode + manual sync** — work disconnected and reconcile changes explicitly, git-style, with push / pull and conflict resolution.
- **Multiple engines** — request `pdflatex`, `xelatex`, `lualatex`, `latex`, or let the server decide (`auto`).

## Requirements

- A reachable Backslash server and an **API key** (`bs_…`).
- VS Code `1.85.0` or newer.

## Getting started

1. **Set your server URL** — open Settings and set `backslash.serverUrl` (default `http://localhost:3000`). Use `http://localhost:3000` if VS Code runs on the server itself.
2. **Set your API key** — run **Backslash: Set API Key** from the Command Palette and paste your `bs_…` key. It is stored securely in VS Code's SecretStorage.
3. **Select a project** — run **Backslash: Select Project** (or use the toolbar in the *Backslash → Project Files* view) and pick the project to link to this workspace. This writes `backslash.projectId` into the workspace settings.
4. **Compile** — open a `.tex` file and press `Ctrl+Alt+B` (or click **Compile & Preview PDF** in the editor title bar). The PDF opens automatically on success.

## Commands

| Command | Description |
| --- | --- |
| `Backslash: Set API Key` | Store your `bs_…` API key in SecretStorage. |
| `Backslash: Clear API Key` | Remove the stored API key. |
| `Backslash: Select Project` | Link a server project to this workspace. |
| `Backslash: Compile & Preview PDF` | Push, compile, and open the PDF (`Ctrl+Alt+B`). |
| `Backslash: Compile (server)` | Compile on the server without pushing first. |
| `Backslash: View PDF` | Open the latest PDF in the viewer (`Ctrl+Alt+V`). |
| `Backslash: Pull PDF` | Download the latest PDF from the server. |
| `Backslash: Show Build Logs` | Show the compiler log output. |
| `Backslash: Download Project (Clone)` | Download all server files into the workspace. |
| `Backslash: Sync → Push Local Changes` | Push local edits to the server. |
| `Backslash: Sync ← Pull Server Changes` | Pull server edits into the workspace. |
| `Backslash: Show Sync Status` | Compare local and server files. |
| `Backslash: Refresh File Tree` | Reload the Project Files view. |
| `Backslash: Upload File to Server` | Upload a file (from the Explorer context menu). |

## Offline mode & manual sync

Enable `backslash.offlineMode` to work without a live connection. Auto build-on-save is disabled, and you synchronize explicitly:

- **Download Project (Clone)** seeds the workspace from the server.
- **Sync → Push** uploads only the files you changed.
- **Sync ← Pull** brings down server changes.
- **Show Sync Status** reports which files are ahead, behind, or in conflict.

Sync state is tracked with SHA-256 content hashes recorded in `.backslash/manifest.json` at the workspace root. When both sides changed a file, you can **keep local**, **take server**, or **open a diff** to decide.

> **Note:** file content is transferred through the server's text API, so binary assets (images, compiled PDFs, fonts, archives) are skipped during sync and cannot be opened remotely. Keep binaries in the workspace and push them via **Compile & Preview**.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `backslash.serverUrl` | `http://localhost:3000` | Base URL of your Backslash server. |
| `backslash.projectId` | `""` | Project linked to this workspace (set by *Select Project*). |
| `backslash.engine` | `auto` | LaTeX engine to request (`auto`/`pdflatex`/`xelatex`/`lualatex`/`latex`). |
| `backslash.pushInclude` | `**/*.{tex,bib,cls,…}` | Glob of files to push. |
| `backslash.pushExclude` | `**/{node_modules,.git,.backslash,out,.vscode}/**` | Glob of files to skip. |
| `backslash.openPdfAfterCompile` | `true` | Open the PDF automatically after a successful compile. |
| `backslash.buildOnSave` | `true` | Compile and preview on every `.tex` save. |
| `backslash.offlineMode` | `false` | Work offline; disable auto build and sync manually. |

## License

[MIT](LICENSE)
