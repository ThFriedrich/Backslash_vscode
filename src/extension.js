const vscode = require("vscode");
const { cfg } = require("./config");
const { initUi, setStatus, logError } = require("./ui");
const { setApiKey, clearApiKey } = require("./api");
const { selectProject, setMainFile } = require("./features/project");
const { pullPdf, openPdf } = require("./features/pdf");
const { isBusy, runPushAndCompile } = require("./features/compile");
const {
  BackslashFileTreeProvider,
  openRemoteFile,
  deleteRemoteFile,
  uploadLocalFile,
  setMainFileFromItem,
} = require("./features/fileTree");
const { pullAll, syncPush, syncPull, syncStatus } = require("./features/sync");

/** Wrap a command handler so unexpected errors are logged and surfaced once. */
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      logError(e);
      vscode.window.showErrorMessage("Backslash: " + (e && e.message ? e.message : e));
    }
  };
}

/** Reflect the current project/offline state in the status bar. */
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

/** Register every contributed command. */
function registerCommands(context, treeProvider) {
  const viewPdf = guard(async () => {
    const uri = await pullPdf(context, false);
    if (uri) await openPdf(context, uri);
  });

  return [
    vscode.commands.registerCommand("backslash.setApiKey", guard(() => setApiKey(context))),
    vscode.commands.registerCommand("backslash.clearApiKey", guard(() => clearApiKey(context))),
    vscode.commands.registerCommand("backslash.selectProject", guard(() => selectProject(context))),
    vscode.commands.registerCommand("backslash.setMainFile", guard(() => setMainFile(context))),
    vscode.commands.registerCommand("backslash.pushAndCompile", runPushAndCompile(context, true)),
    vscode.commands.registerCommand("backslash.compile", runPushAndCompile(context, false)),
    vscode.commands.registerCommand("backslash.pullPdf", viewPdf),
    vscode.commands.registerCommand("backslash.viewPdf", viewPdf),
    vscode.commands.registerCommand("backslash.showLogs", () => require("./ui").getOutput().show(true)),
    vscode.commands.registerCommand("backslash.refreshFileTree", () => treeProvider.refresh()),
    vscode.commands.registerCommand("backslash.pullAll", guard(() => pullAll(context, treeProvider))),
    vscode.commands.registerCommand("backslash.syncPush", guard(() => syncPush(context, treeProvider))),
    vscode.commands.registerCommand("backslash.syncPull", guard(() => syncPull(context, treeProvider))),
    vscode.commands.registerCommand("backslash.syncStatus", guard(() => syncStatus(context))),
    vscode.commands.registerCommand("backslash.openRemoteFile", (item) =>
      guard(() => openRemoteFile(context, item))()
    ),
    vscode.commands.registerCommand("backslash.deleteRemoteFile", (item) =>
      guard(() => deleteRemoteFile(context, treeProvider, item))()
    ),
    vscode.commands.registerCommand("backslash.setMainFileFromTree", (item) =>
      guard(() => setMainFileFromItem(context, treeProvider, item))()
    ),
    vscode.commands.registerCommand("backslash.uploadLocalFile", (fileUri) =>
      guard(() => uploadLocalFile(context, treeProvider, fileUri))()
    ),
  ];
}

function activate(context) {
  const { output, statusBar } = initUi();
  refreshStatus();

  const treeProvider = new BackslashFileTreeProvider(context);
  const treeView = vscode.window.createTreeView("backslashFiles", {
    treeDataProvider: treeProvider,
    showCollapseAll: true,
  });

  const configWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("backslash.projectId")) {
      treeProvider.refresh();
      refreshStatus();
    }
    if (e.affectsConfiguration("backslash.offlineMode")) refreshStatus();
  });

  // Build & preview automatically when a linked .tex file is saved (unless
  // offline mode or the setting is off).
  const buildOnSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    const c = cfg();
    if (c.offlineMode || !c.buildOnSave || !c.projectId) return;
    if (!/\.tex$/i.test(doc.uri.fsPath)) return;
    if (isBusy()) return;
    runPushAndCompile(context, true)();
  });

  context.subscriptions.push(
    output,
    statusBar,
    treeView,
    configWatcher,
    buildOnSave,
    ...registerCommands(context, treeProvider)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
