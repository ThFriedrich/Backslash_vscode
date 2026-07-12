const vscode = require("vscode");
const path = require("path");
const crypto = require("crypto");

/** Convert an absolute file URI to a forward-slashed workspace-relative path. */
function relOf(root, uri) {
  return path.relative(root.fsPath, uri.fsPath).split(path.sep).join("/");
}

/** SHA-256 hex digest of a byte buffer. */
function hashBytes(bytes) {
  return crypto.createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

/**
 * Whether a path/mime should be treated as binary. The v1 API serves file
 * content as UTF-8 text, so binaries can't be synced intact and are skipped.
 */
function isBinaryPath(p, mime) {
  if (mime && (mime.startsWith("image/") || mime === "application/pdf")) return true;
  return /\.(png|jpe?g|gif|pdf|eps|svg|zip|gz|ttf|otf|woff2?|docx?|xlsx?|pptx?)$/i.test(p);
}

/** Write bytes to a workspace-relative path, creating parent folders as needed. */
async function writeLocalFile(root, rel, bytes) {
  const parts = rel.split("/");
  if (parts.length > 1) {
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(root, ...parts.slice(0, -1)));
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(root, ...parts), bytes);
}

/** Human-readable byte size, or undefined when the size is unknown. */
function formatSize(bytes) {
  if (bytes == null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

module.exports = { relOf, hashBytes, isBinaryPath, writeLocalFile, formatSize };
