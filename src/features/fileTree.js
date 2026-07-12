const vscode = require("vscode");
const path = require("path");
const { cfg, workspaceRoot } = require("../config");
const { requireProject, api } = require("../api");
const { log } = require("../ui");
const { formatSize } = require("../util/files");

/** Tree node representing a remote file or folder. */
class BackslashFileItem extends vscode.TreeItem {
  constructor(label, remotePath, isDirectory, size, fileId, isMain) {
    super(
      label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    );
    this.remotePath = remotePath;
    this.isDirectory = isDirectory;
    this.fileId = fileId || null;
    this.contextValue = isDirectory ? "folder" : isMain ? "mainFile" : "file";
    if (!isDirectory) {
      this.command = { command: "backslash.openRemoteFile", title: "Open", arguments: [this] };
      const sz = formatSize(size);
      if (isMain) {
        this.iconPath = new vscode.ThemeIcon("star-full");
        this.description = sz ? `main · ${sz}` : "main";
        this.tooltip = `${remotePath} — compilation entrypoint (main file)`;
      } else {
        this.iconPath = new vscode.ThemeIcon("file");
        if (sz) this.description = sz;
      }
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
    }
  }
}

/** Tree data provider that builds a folder tree from the flat server listing. */
class BackslashFileTreeProvider {
  constructor(context) {
    this._context = context;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this._cache = null;
    this._mainFile = null;
  }

  refresh() {
    this._cache = null;
    this._mainFile = null;
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
        log("File tree error: " + e.message);
        return [
          Object.assign(new vscode.TreeItem(`Error: ${e.message}`), { contextValue: "message" }),
        ];
      }

      // Look up the project's main file so the entrypoint can be highlighted.
      try {
        const proj = await api(this._context, "GET", `/api/v1/projects/${projectId}`);
        const info = proj.project || proj || {};
        this._mainFile = (info.mainFile || info.main || "").replace(/^\/+/, "") || null;
      } catch (e) {
        this._mainFile = null;
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
      .map(([name, info]) =>
        new BackslashFileItem(
          name,
          info.remotePath,
          info.isDir,
          info.size,
          info.id,
          !info.isDir && this._mainFile === info.remotePath
        )
      );
  }
}

/** Download a single remote text file into the workspace and open it. */
async function openRemoteFile(context, item) {
  const projectId = requireProject();
  if (!item.fileId) throw new Error(`No file id for "${item.remotePath}".`);

  // v1 API returns { file: {...}, content: "..." } — content is UTF-8 text.
  const data = await api(context, "GET", `/api/v1/projects/${projectId}/files/${item.fileId}`);
  const content = typeof data.content === "string" ? data.content : "";
  const mime = (data.file && data.file.mimeType) || "";

  // Binaries can't be retrieved intact via the text-only API — warn instead.
  const isBinary =
    mime.startsWith("image/") ||
    mime === "application/pdf" ||
    /\.(png|jpe?g|gif|pdf|eps|svg)$/i.test(item.remotePath);
  if (isBinary) {
    vscode.window.showWarningMessage(
      `"${item.remotePath}" is a binary file and can't be opened via the Backslash API. Use the web UI to view it.`
    );
    log(`Skipped binary remote file: ${item.remotePath} (${mime})`);
    return;
  }

  const buf = new TextEncoder().encode(content);
  const root = workspaceRoot();
  const localUri = vscode.Uri.joinPath(root, ...item.remotePath.split("/"));
  const parts = item.remotePath.split("/");
  if (parts.length > 1) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...parts.slice(0, -1)));
  }
  await vscode.workspace.fs.writeFile(localUri, buf);
  await vscode.window.showTextDocument(localUri, { preview: true });
  log(`Opened remote file: ${item.remotePath}`);
}

/** Delete a remote file after confirmation and refresh the tree. */
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
  log(`Deleted remote file: ${item.remotePath}`);
  treeProvider.refresh();
}

/** Set the given remote file as the project's compilation entrypoint. */
async function setMainFileFromItem(context, treeProvider, item) {
  const projectId = requireProject();
  if (!item || item.isDirectory || !item.remotePath) {
    throw new Error("Select a file to set as the main entrypoint.");
  }
  await api(context, "PUT", `/api/v1/projects/${projectId}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mainFile: item.remotePath }),
  });
  vscode.window.showInformationMessage(`Backslash main file set to "${item.remotePath}".`);
  log(`Main file set to "${item.remotePath}".`);
  treeProvider.refresh();
}

/** Upload a single local file to the server and refresh the tree. */
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
  log(`Uploaded local file: ${rel}`);
  treeProvider.refresh();
}

module.exports = {
  BackslashFileItem,
  BackslashFileTreeProvider,
  openRemoteFile,
  deleteRemoteFile,
  uploadLocalFile,
  setMainFileFromItem,
};
