const vscode = require("vscode");
const path = require("path");
const { cfg, workspaceRoot, TERMINAL_STATES, POLL_INTERVAL_MS, BUILD_TIMEOUT_MS } = require("../config");
const { requireProject, api } = require("../api");
const { log, logError, getOutput, setStatus } = require("../ui");
const { pullPdf, openPdf } = require("./pdf");

// Guards against overlapping builds (e.g. build-on-save firing mid-compile).
let building = false;

/** Whether a compile is currently in progress. */
function isBusy() {
  return building;
}

/** Upload every file matching the push globs to the server (upsert by path). */
async function pushFiles(context) {
  const projectId = requireProject();
  const { include, exclude } = cfg();
  const root = workspaceRoot();
  const uris = await vscode.workspace.findFiles(include, exclude);
  if (!uris.length) throw new Error("No matching files to push.");

  const form = new FormData();
  for (const uri of uris) {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const rel = path.relative(root.fsPath, uri.fsPath).split(path.sep).join("/");
    form.append("files", new Blob([bytes]), rel);
    form.append("paths", rel);
  }
  await api(context, "POST", `/api/v1/projects/${projectId}/files/upload`, { body: form });
  log(`Pushed ${uris.length} file(s).`);
  return uris.length;
}

/** Trigger a server-side compile and return the build id. */
async function compile(context) {
  const projectId = requireProject();
  const { engine } = cfg();
  const data = await api(context, "POST", `/api/v1/projects/${projectId}/compile`, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine }),
  });
  log(`Queued build ${data.buildId || "(unknown id)"} (engine: ${engine}).`);
  return data.buildId;
}

/** Poll the build status until it reaches a terminal state or times out. */
async function pollBuild(context) {
  const projectId = requireProject();
  const start = Date.now();
  while (Date.now() - start < BUILD_TIMEOUT_MS) {
    const data = await api(context, "GET", `/api/v1/projects/${projectId}/builds`);
    const status = data.build && data.build.status;
    if (TERMINAL_STATES.includes(status)) return data;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Timed out waiting for the compile result.");
}

/** Print a build's status, log and errors to the output channel. */
function showBuildLogs(result) {
  const output = getOutput();
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

/**
 * Return a command handler that (optionally) pushes files, compiles on the
 * server, then previews the resulting PDF. Overlapping runs are ignored.
 */
function runPushAndCompile(context, doPush) {
  return () =>
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Backslash", cancellable: false },
      async (progress) => {
        if (building) return;
        building = true;
        try {
          if (doPush) {
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
            vscode.window.showErrorMessage(`Backslash compile ${status}. See "Backslash" output.`);
          }
        } catch (e) {
          setStatus("$(error) Backslash");
          logError(e);
          vscode.window.showErrorMessage("Backslash: " + (e && e.message ? e.message : e));
        } finally {
          building = false;
        }
      }
    );
}

module.exports = { isBusy, pushFiles, compile, pollBuild, showBuildLogs, runPushAndCompile };
