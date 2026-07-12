const vscode = require("vscode");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const SECRET_KEY = "backslash.apiKey";
const TERMINAL_STATES = ["success", "error", "timeout", "canceled"];

let output;
let statusBar;
let isBuilding = false;
let pdfPanel;

function cfg(resource) {
  const c = vscode.workspace.getConfiguration("backslash", resource);
  return {
    serverUrl: (c.get("serverUrl") || "http://localhost:3000").replace(/\/+$/, ""),
    projectId: (c.get("projectId") || "").trim(),
    engine: c.get("engine") || "auto",
    include: c.get("pushInclude") || "**/*.{tex,bib,cls,sty}",
    exclude: c.get("pushExclude") || "**/{node_modules,.git,out,.vscode}/**",
    openPdf: c.get("openPdfAfterCompile") !== false,
    buildOnSave: c.get("buildOnSave") === true,
    offlineMode: c.get("offlineMode") === true,
  };
}

function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    throw new Error("Open a folder to use Backslash.");
  }
  return folders[0].uri;
}

function setStatus(text, tooltip) {
  if (!statusBar) return;
  statusBar.text = text;
  statusBar.tooltip = tooltip || "Backslash: click to Push & Compile";
  statusBar.show();
}

// ─── Auth ────────────────────────────────────────────────────────────

async function setApiKey(context) {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Backslash API key (Dashboard → Developer Settings)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "bs_...",
    validateInput: (v) =>
      v && v.trim().startsWith("bs_") ? undefined : "Key must start with 'bs_'",
  });
  if (!key) return undefined;
  await context.secrets.store(SECRET_KEY, key.trim());
  vscode.window.showInformationMessage("Backslash API key saved.");
  return key.trim();
}

async function requireKey(context) {
  let key = await context.secrets.get(SECRET_KEY);
  if (!key) key = await setApiKey(context);
  if (!key) throw new Error("No API key set.");
  return key;
}

function requireProject() {
  const { projectId } = cfg();
  if (!projectId) {
    throw new Error('No project linked. Run "Backslash: Select Project".');
  }
  return projectId;
}

// ─── HTTP ────────────────────────────────────────────────────────────

async function api(context, method, endpoint, opts = {}) {
  const { serverUrl } = cfg();
  const key = await requireKey(context);
  const res = await fetch(serverUrl + endpoint, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) },
    body: opts.body,
  });
  if (opts.raw) return res;
  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
  }
  return json;
}

// ─── Operations ──────────────────────────────────────────────────────

async function selectProject(context) {
  const data = await api(context, "GET", "/api/v1/projects");
  const projects = data.projects || [];
  if (!projects.length) {
    vscode.window.showWarningMessage(
      "No Backslash projects found. Create one in the web UI first."
    );
    return;
  }
  const pick = await vscode.window.showQuickPick(
    projects.map((p) => ({
      label: p.name || "(unnamed)",
      description: p.id,
      detail: `main: ${p.mainFile || "?"} · last build: ${p.lastBuildStatus || "n/a"}`,
    })),
    { placeHolder: "Link a Backslash project to this workspace" }
  );
  if (!pick) return;
  await vscode.workspace
    .getConfiguration("backslash")
    .update("projectId", pick.description, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`Linked to Backslash project "${pick.label}".`);
  setStatus(`$(rocket) Backslash: ${pick.label}`);
}

async function pushFiles(context) {
  const projectId = requireProject();
  const { include, exclude } = cfg();
  const root = workspaceRoot();
  const uris = await vscode.workspace.findFiles(include, exclude);
  if (!uris.length) throw new Error("No matching files to push.");

  const form = new FormData();
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const rel = path
      .relative(root.fsPath, uri.fsPath)
      .split(path.sep)
      .join("/");
    form.append("files", new Blob([bytes]), rel);
    form.append("paths", rel);
  }
  await api(context, "POST", `/api/v1/projects/${projectId}/files/upload`, {
    body: form,
  });
  output.appendLine(`Pushed ${uris.length} file(s).`);
  return uris.length;
}

async function compile(context) {
  const projectId = requireProject();
  const { engine } = cfg();
  const data = await api(context, "POST", `/api/v1/projects/${projectId}/compile`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  });
  output.appendLine(`Queued build ${data.buildId || "(unknown id)"} (engine: ${engine}).`);
  return data.buildId;
}

async function pollBuild(context) {
  const projectId = requireProject();
  const start = Date.now();
  const timeoutMs = 180000;
  while (Date.now() - start < timeoutMs) {
    const data = await api(context, "GET", `/api/v1/projects/${projectId}/builds`);
    const status = data.build && data.build.status;
    if (TERMINAL_STATES.includes(status)) return data;
    await new Promise((r) => setTimeout(r, 800));
  }
  throw new Error("Timed out waiting for the compile result.");
}

// Stable temp path per project so the preview tab reuses the same file.
function tempPdfUri() {
  const { projectId } = cfg();
  const name = `backslash-${projectId || "preview"}.pdf`;
  return vscode.Uri.file(path.join(os.tmpdir(), name));
}

// Download the compiled PDF. By default writes to a temp file (not the
// workspace). Pass a targetUri to save elsewhere (e.g. workspace out/).
async function pullPdf(context, silent, targetUri) {
  const projectId = requireProject();
  const res = await api(context, "GET", `/api/v1/projects/${projectId}/pdf`, {
    raw: true,
  });
  if (res.status === 404) {
    if (!silent) vscode.window.showWarningMessage("No PDF yet — compile first.");
    return undefined;
  }
  if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const outUri = targetUri || tempPdfUri();
  await vscode.workspace.fs.writeFile(outUri, buf);
  output.appendLine(`Saved PDF → ${outUri.fsPath}`);
  return outUri;
}

function pdfViewerHtml(webview, extensionUri, fileWebviewUri, workerWebviewUri) {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "media", "pdfViewer.js")
  );
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} blob: data:`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `connect-src ${webview.cspSource} blob: data:`,
    `worker-src ${webview.cspSource} blob:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --toolbar-h: 36px;
      --toolbar-bg: #333638;
      --toolbar-fg: #e8e8e8;
      --toolbar-hover: #4a4d4f;
    }
    html, body { margin: 0; padding: 0; height: 100%; background: #525659; overflow: hidden; }
    #toolbar {
      position: fixed;
      top: 0; left: 0; right: 0;
      height: var(--toolbar-h);
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px;
      background: var(--toolbar-bg);
      color: var(--toolbar-fg);
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.4);
      z-index: 10;
      box-sizing: border-box;
      user-select: none;
    }
    #toolbar .sep { width: 1px; height: 20px; background: rgba(255,255,255,0.15); margin: 0 6px; }
    #toolbar .spacer { flex: 1; }
    #toolbar button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 28px;
      height: 26px;
      padding: 0 6px;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--toolbar-fg);
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
    }
    #toolbar button:hover:not(:disabled) { background: var(--toolbar-hover); }
    #toolbar button:disabled { opacity: 0.4; cursor: default; }
    #toolbar button.active { background: var(--toolbar-hover); outline: 1px solid rgba(255,255,255,0.25); }
    #toolbar input#pageInput {
      width: 34px;
      height: 22px;
      text-align: center;
      border: 1px solid rgba(255,255,255,0.2);
      border-radius: 3px;
      background: #1e1e1e;
      color: var(--toolbar-fg);
      font-size: 12px;
    }
    #toolbar .label { opacity: 0.85; padding: 0 2px; }
    #zoomLabel { min-width: 42px; text-align: center; }
    #viewer {
      position: absolute;
      top: var(--toolbar-h);
      left: 0; right: 0; bottom: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 16px 0;
      box-sizing: border-box;
    }
    .page-wrapper { margin: 0 0 16px 0; }
    canvas.page {
      display: block;
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
      background: #fff;
    }
    #status {
      position: fixed;
      top: calc(var(--toolbar-h) + 8px);
      left: 50%;
      transform: translateX(-50%);
      padding: 6px 12px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.7);
      color: #fff;
      font-family: var(--vscode-font-family, sans-serif);
      font-size: 12px;
      display: none;
      z-index: 20;
    }
    #status.error { background: #a1260d; }
  </style>
</head>
<body>
  <div id="toolbar">
    <button id="prev" title="Previous page (PageUp)">▲</button>
    <button id="next" title="Next page (PageDown)">▼</button>
    <input id="pageInput" type="number" min="1" value="1" title="Page" />
    <span id="pageCount" class="label">/ 0</span>
    <span class="sep"></span>
    <button id="zoomOut" title="Zoom out (Ctrl -)">−</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn" title="Zoom in (Ctrl +)">+</button>
    <span class="sep"></span>
    <button id="fitWidth" title="Fit width (Ctrl 0)">Fit width</button>
    <button id="fitPage" title="Fit page">Fit page</button>
    <span class="spacer"></span>
  </div>
  <div id="status"></div>
  <div id="viewer"></div>
  <script nonce="${nonce}">
    window.BACKSLASH = {
      fileUri: ${JSON.stringify(fileWebviewUri.toString())},
      workerUri: ${JSON.stringify(workerWebviewUri.toString())},
    };
  </script>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

// Show the PDF in a custom webview panel (Overleaf-style toolbar viewer).
// The PDF lives in os.tmpdir() so it never pollutes the workspace; its
// directory is added to localResourceRoots so the webview can load it.
async function openPdf(context, uri) {
  const extensionUri = context.extensionUri;
  const pdfDir = vscode.Uri.file(path.dirname(uri.fsPath));
  const mediaDir = vscode.Uri.joinPath(extensionUri, "media");
  const localResourceRoots = [mediaDir, pdfDir];

  if (!pdfPanel) {
    pdfPanel = vscode.window.createWebviewPanel(
      "backslashPdf",
      "Backslash PDF",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots,
      }
    );
    pdfPanel.onDidDispose(() => {
      pdfPanel = undefined;
    });
  } else {
    pdfPanel.webview.options = {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots,
    };
  }

  const workerUri = vscode.Uri.joinPath(mediaDir, "pdfjs", "pdf.worker.min.mjs");
  const fileWebviewUri = pdfPanel.webview.asWebviewUri(uri);
  const workerWebviewUri = pdfPanel.webview.asWebviewUri(workerUri);

  if (pdfPanel.webview.html.length > 0) {
    // Panel already initialised — just reload the (possibly updated) PDF.
    pdfPanel.webview.postMessage({
      type: "load",
      fileUri: fileWebviewUri.toString(),
    });
    pdfPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    pdfPanel.webview.html = pdfViewerHtml(
      pdfPanel.webview,
      extensionUri,
      fileWebviewUri,
      workerWebviewUri
    );
  }
}

function showBuildLogs(result) {
  output.clear();
  const build = (result && result.build) || {};
  output.appendLine(`Build status: ${build.status || "unknown"}`);
  if (build.log || build.logs) {
    output.appendLine("── Log ──");
    output.appendLine(build.log || build.logs);
  }
  const errors = (result && result.errors) || [];
  if (errors.length) {
    output.appendLine("── Errors ──");
    for (const e of errors) {
      const where = e.file ? `${e.file}:${e.line || "?"}` : "";
      output.appendLine(`${where} ${e.message || JSON.stringify(e)}`.trim());
    }
  }
  output.show(true);
}

// ─── File Tree ───────────────────────────────────────────────────────

function formatSize(bytes) {
  if (bytes == null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

class BackslashFileItem extends vscode.TreeItem {
  constructor(label, remotePath, isDirectory, size, fileId) {
    super(
      label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.remotePath = remotePath;
    this.isDirectory = isDirectory;
    this.fileId = fileId || null;
    this.contextValue = isDirectory ? "folder" : "file";
    if (!isDirectory) {
      this.command = {
        command: "backslash.openRemoteFile",
        title: "Open",
        arguments: [this],
      };
      const sz = formatSize(size);
      if (sz) this.description = sz;
      this.iconPath = new vscode.ThemeIcon("file");
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
    }
  }
}

class BackslashFileTreeProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
  }

  refresh() {
    this._cache = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    const { projectId } = cfg();
    if (!projectId) {
      return [
        Object.assign(
          new vscode.TreeItem('No project linked — run "Backslash: Select Project"'),
          { contextValue: "message" }
        ),
      ];
    }

    if (!this._cache) {
      try {
        const data = await api(this._context, "GET", `/api/v1/projects/${projectId}/files`);
        const raw = data.files || data.entries || data || [];
        this._cache = raw.map((f) => (typeof f === "string" ? { path: f } : f));
      } catch (e) {
        output.appendLine("File tree error: " + e.message);
        return [
          Object.assign(new vscode.TreeItem(`Error: ${e.message}`), {
            contextValue: "message",
          }),
        ];
      }
    }

    const prefix = element ? element.remotePath + "/" : "";
    const children = new Map();

    for (const f of this._cache) {
      if (!f.path.startsWith(prefix)) continue;
      const rest = f.path.slice(prefix.length);
      if (!rest) continue;
      const slashIdx = rest.indexOf("/");
      if (slashIdx === -1) {
        children.set(rest, {
          isDir: f.isDirectory === true,
          remotePath: f.path,
          size: f.sizeBytes ?? f.size,
          id: f.id,
        });
      } else {
        const folderName = rest.slice(0, slashIdx);
        if (!children.has(folderName)) {
          // Find the explicit directory entry if present
          const dirEntry = this._cache.find(
            (d) => d.isDirectory && d.path === prefix + folderName
          );
          children.set(folderName, {
            isDir: true,
            remotePath: prefix + folderName,
            id: dirEntry ? dirEntry.id : null,
          });
        }
      }
    }

    return [...children.entries()]
      .sort(([a, av], [b, bv]) => {
        if (av.isDir !== bv.isDir) return av.isDir ? -1 : 1;
        return a.localeCompare(b);
      })
      .map(([name, info]) => new BackslashFileItem(name, info.remotePath, info.isDir, info.size, info.id));
  }
}

async function openRemoteFile(context, item) {
  const projectId = requireProject();
  if (!item.fileId) throw new Error(`No file id for "${item.remotePath}".`);

  // v1 API returns { file: {...}, content: "..." } — content is UTF-8 text.
  const data = await api(
    context,
    "GET",
    `/api/v1/projects/${projectId}/files/${item.fileId}`
  );
  const content = typeof data.content === "string" ? data.content : "";
  const mime = (data.file && data.file.mimeType) || "";

  // The v1 API reads files as UTF-8 text, so true binaries (images/PDF) can't
  // be retrieved intact. Warn instead of writing a corrupted file.
  const isBinary =
    mime.startsWith("image/") ||
    mime === "application/pdf" ||
    /\.(png|jpe?g|gif|pdf|eps|svg)$/i.test(item.remotePath);
  if (isBinary) {
    vscode.window.showWarningMessage(
      `"${item.remotePath}" is a binary file and can't be opened via the Backslash API. Use the web UI to view it.`
    );
    output.appendLine(`Skipped binary remote file: ${item.remotePath} (${mime})`);
    return;
  }

  const buf = new TextEncoder().encode(content);
  const root = workspaceRoot();
  const localUri = vscode.Uri.joinPath(root, ...item.remotePath.split("/"));
  const parts = item.remotePath.split("/");
  if (parts.length > 1) {
    const parentUri = vscode.Uri.joinPath(root, ...parts.slice(0, -1));
    await vscode.workspace.fs.createDirectory(parentUri);
  }
  await vscode.workspace.fs.writeFile(localUri, buf);
  await vscode.window.showTextDocument(localUri, { preview: true });
  output.appendLine(`Opened remote file: ${item.remotePath}`);
}

async function deleteRemoteFile(context, treeProvider, item) {
  const projectId = requireProject();
  const answer = await vscode.window.showWarningMessage(
    `Delete "${item.remotePath}" on the Backslash server?`,
    { modal: true },
    "Delete"
  );
  if (answer !== "Delete") return;
  const endpoint = item.fileId
    ? `/api/v1/projects/${projectId}/files/${item.fileId}`
    : `/api/v1/projects/${projectId}/files/${item.remotePath.split("/").map(encodeURIComponent).join("/")}`;
  await api(context, "DELETE", endpoint);
  vscode.window.showInformationMessage(`Deleted "${item.remotePath}" from server.`);
  output.appendLine(`Deleted remote file: ${item.remotePath}`);
  treeProvider.refresh();
}

async function uploadLocalFile(context, treeProvider, fileUri) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const rel = path.relative(root.fsPath, fileUri.fsPath).split(path.sep).join("/");
  const bytes = await vscode.workspace.fs.readFile(fileUri);
  const form = new FormData();
  form.append("files", new Blob([bytes]), rel);
  form.append("paths", rel);
  await api(context, "POST", `/api/v1/projects/${projectId}/files/upload`, { body: form });
  vscode.window.showInformationMessage(`Uploaded "${rel}" to server.`);
  output.appendLine(`Uploaded local file: ${rel}`);
  treeProvider.refresh();
}

// ─── Offline mode & manual sync ──────────────────────────────────────
//
// The local workspace is the working copy. A snapshot manifest at
// `.backslash/manifest.json` records the content hash + server file id of
// every file at the moment of the last sync. Comparing current local files
// and current server files against that snapshot lets us detect what changed
// on each side (git-style), push/pull only the differences, and flag files
// that changed on BOTH sides as conflicts.

function relOf(root, uri) {
  return path.relative(root.fsPath, uri.fsPath).split(path.sep).join("/");
}

function hashBytes(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

// The v1 API serves file content as UTF-8 text, so true binaries can't be
// synced intact. They are skipped (edit/upload them via the web UI or the
// file tree's upload command instead).
function isBinaryPath(p, mime) {
  if (mime && (mime.startsWith("image/") || mime === "application/pdf")) return true;
  return /\.(png|jpe?g|gif|pdf|eps|svg|zip|gz|ttf|otf|woff2?|docx?|xlsx?|pptx?)$/i.test(p);
}

function manifestUri() {
  return vscode.Uri.joinPath(workspaceRoot(), ".backslash", "manifest.json");
}

async function readManifest() {
  try {
    const bytes = await vscode.workspace.fs.readFile(manifestUri());
    const m = JSON.parse(new TextDecoder().decode(bytes));
    if (!m.files) m.files = {};
    return m;
  } catch {
    return { projectId: cfg().projectId, lastSync: null, files: {} };
  }
}

async function writeManifest(manifest) {
  manifest.projectId = cfg().projectId;
  manifest.lastSync = new Date().toISOString();
  const dir = vscode.Uri.joinPath(workspaceRoot(), ".backslash");
  await vscode.workspace.fs.createDirectory(dir);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await vscode.workspace.fs.writeFile(manifestUri(), bytes);
}

async function writeLocalFile(root, rel, bytes) {
  const parts = rel.split("/");
  if (parts.length > 1) {
    await vscode.workspace.fs.createDirectory(
      vscode.Uri.joinPath(root, ...parts.slice(0, -1))
    );
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ...parts), bytes);
}

// Flat list of non-directory server files: [{ path, id, sizeBytes }].
async function fetchRemoteList(context, projectId) {
  const data = await api(context, "GET", `/api/v1/projects/${projectId}/files`);
  const raw = data.files || data.entries || data || [];
  return raw
    .map((f) => (typeof f === "string" ? { path: f } : f))
    .filter((f) => f && f.path && f.isDirectory !== true);
}

async function fetchRemoteContent(context, projectId, fileId) {
  const data = await api(context, "GET", `/api/v1/projects/${projectId}/files/${fileId}`);
  return {
    content: typeof data.content === "string" ? data.content : "",
    mime: (data.file && data.file.mimeType) || "",
  };
}

async function pushSpecific(context, projectId, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const { rel, bytes } of files) {
    form.append("files", new Blob([bytes]), rel);
    form.append("paths", rel);
  }
  await api(context, "POST", `/api/v1/projects/${projectId}/files/upload`, { body: form });
}

// Collect local text files as a Map(relPath -> bytes), honoring push globs and
// skipping the manifest folder + binaries.
async function collectLocalFiles() {
  const { include, exclude } = cfg();
  const root = workspaceRoot();
  const uris = await vscode.workspace.findFiles(include, exclude);
  const map = new Map();
  for (const uri of uris) {
    const rel = relOf(root, uri);
    if (rel === ".backslash" || rel.startsWith(".backslash/")) continue;
    if (isBinaryPath(rel)) continue;
    map.set(rel, await vscode.workspace.fs.readFile(uri));
  }
  return map;
}

// Interactive per-file conflict prompt. Returns "local" | "server" | "skip".
async function resolveConflict(rel, remoteContent) {
  for (;;) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: "$(arrow-up) Keep local",
          detail: "Use your local version (overwrites the server copy on push)",
          value: "local",
        },
        {
          label: "$(arrow-down) Take server",
          detail: "Overwrite your local file with the server version",
          value: "server",
        },
        { label: "$(diff) Open diff…", detail: "Compare both versions first", value: "diff" },
        { label: "$(circle-slash) Skip", detail: "Leave this file for now", value: "skip" },
      ],
      {
        placeHolder: `Conflict: "${rel}" changed both locally and on the server`,
        ignoreFocusOut: true,
      }
    );
    if (!pick || pick.value === "skip") return "skip";
    if (pick.value === "diff") {
      const localUri = vscode.Uri.joinPath(workspaceRoot(), ...rel.split("/"));
      const tmp = vscode.Uri.file(
        path.join(os.tmpdir(), "backslash-server-" + rel.replace(/[\\/]/g, "__"))
      );
      await vscode.workspace.fs.writeFile(tmp, new TextEncoder().encode(remoteContent));
      await vscode.commands.executeCommand(
        "vscode.diff",
        tmp,
        localUri,
        `Server ↔ Local: ${rel}`
      );
      continue;
    }
    return pick.value;
  }
}

// Download the entire project into the workspace and (re)create the manifest.
async function pullAll(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const list = await fetchRemoteList(context, projectId);
  const manifest = { projectId, lastSync: null, files: {} };
  let pulled = 0;
  let skipped = 0;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Backslash: Downloading project" },
    async (progress) => {
      for (const f of list) {
        if (isBinaryPath(f.path)) {
          skipped++;
          continue;
        }
        progress.report({ message: f.path });
        const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
        if (isBinaryPath(f.path, mime)) {
          skipped++;
          continue;
        }
        const bytes = new TextEncoder().encode(content);
        await writeLocalFile(root, f.path, bytes);
        manifest.files[f.path] = { fileId: f.id, hash: hashBytes(bytes), size: bytes.length };
        pulled++;
      }
    }
  );

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  output.appendLine(`Cloned project: ${pulled} file(s) downloaded, ${skipped} binary skipped.`);
  vscode.window.showInformationMessage(
    `Backslash: downloaded ${pulled} file(s) to the workspace.` +
      (skipped ? ` ${skipped} binary file(s) skipped.` : "")
  );
}

// Push local changes (new + modified) to the server, with conflict handling.
async function syncPush(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const manifest = await readManifest();
  const local = await collectLocalFiles();
  const remoteList = await fetchRemoteList(context, projectId);
  const remoteByPath = new Map(remoteList.map((f) => [f.path, f]));

  const toPush = [];
  const conflicts = [];

  for (const [rel, bytes] of local) {
    const h = hashBytes(bytes);
    const rec = manifest.files[rel];
    if (rec && rec.hash === h) continue; // unchanged since last sync
    const remote = remoteByPath.get(rel);
    // Only a tracked file can conflict; a brand-new local file just pushes.
    if (rec && remote) {
      const { content } = await fetchRemoteContent(context, projectId, remote.id);
      const remoteHash = hashBytes(new TextEncoder().encode(content));
      if (remoteHash !== rec.hash) {
        conflicts.push({ rel, bytes, remoteContent: content, remote });
        continue;
      }
    }
    toPush.push({ rel, bytes });
  }

  // Files tracked in the manifest but no longer present locally → deletions.
  const deletions = Object.keys(manifest.files).filter(
    (rel) => !local.has(rel) && remoteByPath.has(rel)
  );

  if (!toPush.length && !conflicts.length && !deletions.length) {
    vscode.window.showInformationMessage("Backslash: nothing to push — server is up to date.");
    return;
  }

  for (const c of conflicts) {
    const choice = await resolveConflict(c.rel, c.remoteContent);
    if (choice === "local") {
      toPush.push({ rel: c.rel, bytes: c.bytes });
    } else if (choice === "server") {
      const rbytes = new TextEncoder().encode(c.remoteContent);
      await writeLocalFile(root, c.rel, rbytes);
      manifest.files[c.rel] = { fileId: c.remote.id, hash: hashBytes(rbytes), size: rbytes.length };
    }
    // "skip" leaves the file flagged until the next sync.
  }

  let doDelete = [];
  if (deletions.length) {
    const ans = await vscode.window.showWarningMessage(
      `Delete ${deletions.length} file(s) on the server that were removed locally?\n\n${deletions.join("\n")}`,
      { modal: true },
      "Delete on Server",
      "Keep on Server"
    );
    if (ans === "Delete on Server") doDelete = deletions;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Backslash: Pushing" },
    async (progress) => {
      if (toPush.length) {
        progress.report({ message: `Uploading ${toPush.length} file(s)…` });
        await pushSpecific(context, projectId, toPush);
        for (const { rel, bytes } of toPush) {
          manifest.files[rel] = {
            fileId: (remoteByPath.get(rel) || {}).id || (manifest.files[rel] || {}).fileId || null,
            hash: hashBytes(bytes),
            size: bytes.length,
          };
        }
      }
      for (const rel of doDelete) {
        progress.report({ message: `Deleting ${rel}…` });
        const remote = remoteByPath.get(rel);
        if (remote) await api(context, "DELETE", `/api/v1/projects/${projectId}/files/${remote.id}`);
        delete manifest.files[rel];
      }
    }
  );

  // New files have no id yet — refresh the server list to capture them.
  const after = await fetchRemoteList(context, projectId);
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  for (const rel of Object.keys(manifest.files)) {
    if (!manifest.files[rel].fileId && afterByPath.has(rel)) {
      manifest.files[rel].fileId = afterByPath.get(rel).id;
    }
  }

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  const parts = [];
  if (toPush.length) parts.push(`${toPush.length} pushed`);
  if (doDelete.length) parts.push(`${doDelete.length} deleted`);
  output.appendLine(`Sync push: ${parts.join(", ") || "no changes"}.`);
  vscode.window.showInformationMessage(`Backslash push complete — ${parts.join(", ") || "no changes"}.`);
}

// Pull server changes (new + modified) into the workspace, with conflicts.
async function syncPull(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const manifest = await readManifest();
  const remoteList = await fetchRemoteList(context, projectId);

  const changes = []; // remote new/modified, local clean
  const conflicts = []; // changed on both sides
  const remotePaths = new Set();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Backslash: Checking server" },
    async (progress) => {
      for (const f of remoteList) {
        if (isBinaryPath(f.path)) continue;
        progress.report({ message: f.path });
        const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
        if (isBinaryPath(f.path, mime)) continue;
        remotePaths.add(f.path);
        const rbytes = new TextEncoder().encode(content);
        const rhash = hashBytes(rbytes);
        const rec = manifest.files[f.path];
        if (rec && rec.hash === rhash) continue; // server unchanged

        let localHash = null;
        try {
          const lb = await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(root, ...f.path.split("/"))
          );
          localHash = hashBytes(lb);
        } catch {
          /* no local copy */
        }

        if (rec && localHash && localHash !== rec.hash) {
          conflicts.push({ rel: f.path, remote: f, content, bytes: rbytes, hash: rhash });
        } else {
          changes.push({ rel: f.path, remote: f, bytes: rbytes, hash: rhash });
        }
      }
    }
  );

  // Tracked files gone from the server → offer to delete the local copy.
  const remoteDeleted = Object.keys(manifest.files).filter(
    (rel) => !remotePaths.has(rel) && !isBinaryPath(rel)
  );

  if (!changes.length && !conflicts.length && !remoteDeleted.length) {
    vscode.window.showInformationMessage("Backslash: nothing to pull — workspace is up to date.");
    return;
  }

  for (const c of conflicts) {
    const choice = await resolveConflict(c.rel, c.content);
    if (choice === "server") {
      changes.push(c); // apply below
    }
    // "local"/"skip": keep local file; leave flagged until pushed.
  }

  let localDelete = [];
  if (remoteDeleted.length) {
    const ans = await vscode.window.showWarningMessage(
      `${remoteDeleted.length} file(s) were deleted on the server. Delete them locally too?\n\n${remoteDeleted.join("\n")}`,
      { modal: true },
      "Delete Locally",
      "Keep Locally"
    );
    if (ans === "Delete Locally") localDelete = remoteDeleted;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Backslash: Pulling" },
    async (progress) => {
      for (const c of changes) {
        progress.report({ message: c.rel });
        await writeLocalFile(root, c.rel, c.bytes);
        manifest.files[c.rel] = { fileId: c.remote.id, hash: c.hash, size: c.bytes.length };
      }
      for (const rel of localDelete) {
        progress.report({ message: `Deleting ${rel}…` });
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...rel.split("/")));
        } catch {
          /* already gone */
        }
        delete manifest.files[rel];
      }
    }
  );

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  const parts = [];
  if (changes.length) parts.push(`${changes.length} updated`);
  if (localDelete.length) parts.push(`${localDelete.length} removed`);
  output.appendLine(`Sync pull: ${parts.join(", ") || "no changes"}.`);
  vscode.window.showInformationMessage(`Backslash pull complete — ${parts.join(", ") || "no changes"}.`);
}

// Dry-run summary of what a push/pull would do, printed to the output channel.
async function syncStatus(context) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const manifest = await readManifest();
  const local = await collectLocalFiles();
  const remoteList = await fetchRemoteList(context, projectId);
  const remoteByPath = new Map(remoteList.map((f) => [f.path, f]));
  const remoteHashes = new Map();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Backslash: Computing status" },
    async () => {
      for (const f of remoteList) {
        if (isBinaryPath(f.path)) continue;
        const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
        if (isBinaryPath(f.path, mime)) continue;
        remoteHashes.set(f.path, hashBytes(new TextEncoder().encode(content)));
      }
    }
  );

  const localOnly = [];
  const localMod = [];
  const remoteOnly = [];
  const remoteMod = [];
  const conflicts = [];
  const localDeleted = [];
  const remoteDeleted = [];

  for (const [rel, bytes] of local) {
    const h = hashBytes(bytes);
    const rec = manifest.files[rel];
    if (!rec) {
      if (!remoteByPath.has(rel)) localOnly.push(rel);
      else localMod.push(rel);
      continue;
    }
    const localChanged = h !== rec.hash;
    const rh = remoteHashes.get(rel);
    const remoteChanged = rh !== undefined && rh !== rec.hash;
    if (localChanged && remoteChanged) conflicts.push(rel);
    else if (localChanged) localMod.push(rel);
  }
  for (const [rel, rh] of remoteHashes) {
    const rec = manifest.files[rel];
    if (!rec) {
      if (!local.has(rel)) remoteOnly.push(rel);
      continue;
    }
    if (!local.has(rel)) {
      // present remotely + tracked but missing locally
      if (rh !== rec.hash) remoteMod.push(rel);
    } else if (rh !== rec.hash && hashBytes(local.get(rel)) === rec.hash) {
      remoteMod.push(rel);
    }
  }
  for (const rel of Object.keys(manifest.files)) {
    if (!local.has(rel) && remoteByPath.has(rel)) localDeleted.push(rel);
    if (local.has(rel) && !remoteByPath.has(rel)) remoteDeleted.push(rel);
  }

  output.clear();
  output.appendLine("Backslash sync status");
  output.appendLine(`Last sync: ${manifest.lastSync || "never"}`);
  const section = (title, arr) => {
    output.appendLine(`\n${title} (${arr.length})`);
    for (const r of arr) output.appendLine(`  ${r}`);
  };
  section("↑ New locally (push)", localOnly);
  section("↑ Modified locally (push)", localMod);
  section("↑ Deleted locally (push removes on server)", localDeleted);
  section("↓ New on server (pull)", remoteOnly);
  section("↓ Modified on server (pull)", remoteMod);
  section("↓ Deleted on server (pull removes locally)", remoteDeleted);
  section("⚠ Conflicts (changed on both sides)", conflicts);
  output.show(true);
}

// ─── Command wrappers ────────────────────────────────────────────────

function guard(fn) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      output.appendLine("Error: " + (e && e.message ? e.message : String(e)));
      vscode.window.showErrorMessage("Backslash: " + (e && e.message ? e.message : e));
    }
  };
}

function runPushAndCompile(context, doPush) {
  return () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Backslash", cancellable: false },
      async (progress) => {
        if (isBuilding) return;
        isBuilding = true;
        try {
          if (doPush) {
            // Persist the current editor edits before uploading.
            const active = vscode.window.activeTextEditor;
            if (active && active.document.isDirty) await active.document.save();
            progress.report({ message: "Pushing files…" });
            await pushFiles(context);
          }
          progress.report({ message: "Compiling on server…" });
          await compile(context);
          const result = await pollBuild(context);
          const status = result.build.status;
          if (status === "success") {
            setStatus("$(check) Backslash: success");
            if (cfg().openPdf) {
              progress.report({ message: "Fetching PDF…" });
              const uri = await pullPdf(context, true);
              if (uri) await openPdf(context, uri);
            }
            vscode.window.showInformationMessage("Backslash compile succeeded.");
          } else {
            setStatus(`$(error) Backslash: ${status}`);
            showBuildLogs(result);
            vscode.window.showErrorMessage(
              `Backslash compile ${status}. See "Backslash" output.`
            );
          }
        } catch (e) {
          setStatus("$(error) Backslash");
          output.appendLine("Error: " + (e && e.message ? e.message : String(e)));
          vscode.window.showErrorMessage("Backslash: " + (e && e.message ? e.message : e));
        } finally {
          isBuilding = false;
        }
      }
    );
}

// ─── Activation ──────────────────────────────────────────────────────

function activate(context) {
  output = vscode.window.createOutputChannel("Backslash");

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = "backslash.pushAndCompile";
  const { projectId } = cfg();
  setStatus(projectId ? "$(rocket) Backslash" : "$(rocket) Backslash: link project");

  const treeProvider = new BackslashFileTreeProvider(context);
  const treeView = vscode.window.createTreeView("backslashFiles", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  // Refresh tree when the active project changes
  vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("backslash.projectId")) treeProvider.refresh();
    if (e.affectsConfiguration("backslash.offlineMode")) refreshStatus();
  });

  function refreshStatus() {
    const c = cfg();
    if (!c.projectId) {
      setStatus("$(rocket) Backslash: link project");
    } else if (c.offlineMode) {
      setStatus("$(plug) Backslash: offline", "Backslash offline mode — auto build on save is disabled");
    } else {
      setStatus("$(rocket) Backslash");
    }
  }
  refreshStatus();

  // Build & preview automatically when a linked .tex file is saved.
  const buildOnSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (cfg().offlineMode) return;
    if (!cfg().buildOnSave) return;
    if (!/\.tex$/i.test(doc.uri.fsPath)) return;
    if (!cfg().projectId) return;
    if (isBuilding) return;
    runPushAndCompile(context, true)();
  });

  context.subscriptions.push(
    output,
    statusBar,
    treeView,
    buildOnSave,
    vscode.commands.registerCommand("backslash.setApiKey", guard(() => setApiKey(context))),
    vscode.commands.registerCommand(
      "backslash.clearApiKey",
      guard(async () => {
        await context.secrets.delete(SECRET_KEY);
        vscode.window.showInformationMessage("Backslash API key cleared.");
      })
    ),
    vscode.commands.registerCommand(
      "backslash.selectProject",
      guard(() => selectProject(context))
    ),
    vscode.commands.registerCommand(
      "backslash.pushAndCompile",
      runPushAndCompile(context, true)
    ),
    vscode.commands.registerCommand(
      "backslash.compile",
      runPushAndCompile(context, false)
    ),
    vscode.commands.registerCommand(
      "backslash.pullPdf",
      guard(async () => {
        const uri = await pullPdf(context, false);
        if (uri) await openPdf(context, uri);
      })
    ),
    vscode.commands.registerCommand(
      "backslash.viewPdf",
      guard(async () => {
        const uri = await pullPdf(context, false);
        if (uri) await openPdf(context, uri);
      })
    ),
    vscode.commands.registerCommand("backslash.showLogs", () => output.show(true)),
    vscode.commands.registerCommand("backslash.refreshFileTree", () => treeProvider.refresh()),
    vscode.commands.registerCommand(
      "backslash.pullAll",
      guard(() => pullAll(context, treeProvider))
    ),
    vscode.commands.registerCommand(
      "backslash.syncPush",
      guard(() => syncPush(context, treeProvider))
    ),
    vscode.commands.registerCommand(
      "backslash.syncPull",
      guard(() => syncPull(context, treeProvider))
    ),
    vscode.commands.registerCommand(
      "backslash.syncStatus",
      guard(() => syncStatus(context))
    ),
    vscode.commands.registerCommand("backslash.openRemoteFile", (item) =>
      guard(() => openRemoteFile(context, item))()
    ),
    vscode.commands.registerCommand("backslash.deleteRemoteFile", (item) =>
      guard(() => deleteRemoteFile(context, treeProvider, item))()
    ),
    vscode.commands.registerCommand("backslash.uploadLocalFile", (fileUri) =>
      guard(() => uploadLocalFile(context, treeProvider, fileUri))()
    )
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
