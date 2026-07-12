const vscode = require("vscode");
const path = require("path");
const os = require("os");
const { workspaceRoot } = require("../../config");

/**
 * Prompt the user to resolve a file that changed on both sides.
 * Returns "local" (keep local), "server" (take server) or "skip".
 * Choosing "Open diff…" shows a side-by-side comparison, then re-prompts.
 */
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
      await vscode.commands.executeCommand("vscode.diff", tmp, localUri, `Server ↔ Local: ${rel}`);
      continue;
    }
    return pick.value;
  }
}

module.exports = { resolveConflict };
