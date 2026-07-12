const vscode = require("vscode");
const { cfg, workspaceRoot, MANIFEST_DIR, MANIFEST_FILE } = require("../../config");

// The manifest at `.backslash/manifest.json` is a snapshot of every synced
// file's content hash + server id at the moment of the last sync. Comparing
// the current local files and the current server files against this snapshot
// is what lets sync detect per-side changes (git-style) and conflicts.

/** URI of the manifest file inside the workspace. */
function manifestUri() {
  return vscode.Uri.joinPath(workspaceRoot(), MANIFEST_DIR, MANIFEST_FILE);
}

/** Read the manifest, returning an empty one when it does not exist. */
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

/** Persist the manifest, stamping the current project id and sync time. */
async function writeManifest(manifest) {
  manifest.projectId = cfg().projectId;
  manifest.lastSync = new Date().toISOString();
  const dir = vscode.Uri.joinPath(workspaceRoot(), MANIFEST_DIR);
  await vscode.workspace.fs.createDirectory(dir);
  const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
  await vscode.workspace.fs.writeFile(manifestUri(), bytes);
}

module.exports = { manifestUri, readManifest, writeManifest };
