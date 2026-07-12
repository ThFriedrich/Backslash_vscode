const vscode = require("vscode");

let output;
let statusBar;

/**
 * Create the shared output channel and status-bar item. Called once during
 * activation; the created disposables should be added to context.subscriptions.
 */
function initUi() {
  output = vscode.window.createOutputChannel("Backslash");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBar.command = "backslash.pushAndCompile";
  return { output, statusBar };
}

/** The shared "Backslash" output channel. */
function getOutput() {
  return output;
}

/** Append a line to the Backslash output channel. */
function log(message) {
  if (output) output.appendLine(message);
}

/** Log an error (Error or string) to the output channel. */
function logError(err) {
  log("Error: " + (err && err.message ? err.message : String(err)));
}

/** Update the status-bar item text and tooltip, and make sure it is visible. */
function setStatus(text, tooltip) {
  if (!statusBar) return;
  statusBar.text = text;
  statusBar.tooltip = tooltip || "Backslash: click to Compile & Preview";
  statusBar.show();
}

module.exports = { initUi, getOutput, log, logError, setStatus };
