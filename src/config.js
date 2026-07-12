const vscode = require("vscode");

/** SecretStorage key under which the API token is stored. */
const SECRET_KEY = "backslash.apiKey";

/** Build states that end a compile poll loop. */
const TERMINAL_STATES = ["success", "error", "timeout", "canceled"];

/** Fallback server URL when the setting is empty. */
const DEFAULT_SERVER_URL = "http://localhost:3000";

/** How often to poll the build status endpoint, in milliseconds. */
const POLL_INTERVAL_MS = 800;

/** How long to wait for a build to finish before giving up, in milliseconds. */
const BUILD_TIMEOUT_MS = 180000;

/** Workspace-relative folder that holds the offline sync manifest. */
const MANIFEST_DIR = ".backslash";
const MANIFEST_FILE = "manifest.json";

/**
 * Read the effective Backslash configuration for a given resource (defaults to
 * the active workspace when omitted).
 */
function cfg(resource) {
  const c = vscode.workspace.getConfiguration("backslash", resource);
  return {
    serverUrl: (c.get("serverUrl") || DEFAULT_SERVER_URL).replace(/\/+$/, ""),
    projectId: (c.get("projectId") || "").trim(),
    engine: c.get("engine") || "auto",
    include: c.get("pushInclude") || "**/*.{tex,bib,cls,sty}",
    exclude: c.get("pushExclude") || "**/{node_modules,.git,.backslash,out,.vscode}/**",
    openPdf: c.get("openPdfAfterCompile") !== false,
    buildOnSave: c.get("buildOnSave") === true,
    offlineMode: c.get("offlineMode") === true,
  };
}

/** Return the first workspace folder URI, or throw if none is open. */
function workspaceRoot() {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || !folders.length) {
    throw new Error("Open a folder to use Backslash.");
  }
  return folders[0].uri;
}

module.exports = {
  SECRET_KEY,
  TERMINAL_STATES,
  DEFAULT_SERVER_URL,
  POLL_INTERVAL_MS,
  BUILD_TIMEOUT_MS,
  MANIFEST_DIR,
  MANIFEST_FILE,
  cfg,
  workspaceRoot,
};
