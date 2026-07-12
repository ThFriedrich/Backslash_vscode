const vscode = require("vscode");
const path = require("path");
const { api, requireProject } = require("../api");
const { cfg, workspaceRoot } = require("../config");
const { setStatus, log } = require("../ui");

/** Let the user pick a Backslash project and link it to the workspace. */
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

/**
 * Let the user choose which `.tex` file is the compilation entrypoint and
 * persist it as the project's main file on the server.
 */
async function setMainFile(context) {
  const projectId = requireProject();
  const root = workspaceRoot();

  const uris = await vscode.workspace.findFiles("**/*.tex", cfg().exclude);
  if (!uris.length) {
    vscode.window.showWarningMessage("No .tex files found in this workspace.");
    return;
  }

  const rels = uris
    .map((uri) => path.relative(root.fsPath, uri.fsPath).split(path.sep).join("/"))
    .sort();

  const pick = await vscode.window.showQuickPick(rels, {
    placeHolder: "Select the main file (compilation entrypoint)",
  });
  if (!pick) return;

  await api(context, "PUT", `/api/v1/projects/${projectId}`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mainFile: pick }),
  });
  log(`Main file set to "${pick}".`);
  vscode.window.showInformationMessage(`Backslash main file set to "${pick}".`);
}

module.exports = { selectProject, setMainFile };

