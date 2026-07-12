const vscode = require("vscode");
const path = require("path");
const os = require("os");
const { cfg } = require("../config");
const { requireProject, api } = require("../api");
const { log } = require("../ui");

// Single reusable preview panel so recompiles refresh in place.
let pdfPanel;

/**
 * Stable temp path per project so the preview tab keeps reusing the same file
 * (and therefore never pollutes the workspace).
 */
function tempPdfUri() {
  const { projectId } = cfg();
  return vscode.Uri.file(path.join(os.tmpdir(), `backslash-${projectId || "preview"}.pdf`));
}

/**
 * Download the compiled PDF. Writes to a temp file by default; pass `targetUri`
 * to save elsewhere. Returns the written URI, or undefined when no PDF exists.
 */
async function pullPdf(context, silent, targetUri) {
  const projectId = requireProject();
  const res = await api(context, "GET", `/api/v1/projects/${projectId}/pdf`, { raw: true });
  if (res.status === 404) {
    if (!silent) vscode.window.showWarningMessage("No PDF yet — compile first.");
    return undefined;
  }
  if (!res.ok) throw new Error(`PDF download failed: HTTP ${res.status}`);

  const buf = new Uint8Array(await res.arrayBuffer());
  const outUri = targetUri || tempPdfUri();
  await vscode.workspace.fs.writeFile(outUri, buf);
  log(`Saved PDF → ${outUri.fsPath}`);
  return outUri;
}

/** Build the webview HTML from the template, filling in the CSP/nonce/URIs. */
async function renderViewerHtml(webview, extensionUri, fileWebviewUri, workerWebviewUri) {
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

  const templateUri = vscode.Uri.joinPath(extensionUri, "media", "pdfViewer.html");
  const template = new TextDecoder().decode(await vscode.workspace.fs.readFile(templateUri));
  return template
    .replaceAll("__CSP__", csp)
    .replaceAll("__NONCE__", nonce)
    .replaceAll("__SCRIPT_URI__", scriptUri.toString())
    .replaceAll("__FILE_URI__", fileWebviewUri.toString())
    .replaceAll("__WORKER_URI__", workerWebviewUri.toString());
}

/**
 * Show the PDF in the custom toolbar viewer (zoom, fit, page navigation). The
 * panel is reused across compiles; the PDF's temp directory is added to
 * localResourceRoots so the webview can load it.
 */
async function openPdf(context, uri) {
  const extensionUri = context.extensionUri;
  const pdfDir = vscode.Uri.file(path.dirname(uri.fsPath));
  const mediaDir = vscode.Uri.joinPath(extensionUri, "media");
  const localResourceRoots = [mediaDir, pdfDir];
  const webviewOptions = { enableScripts: true, retainContextWhenHidden: true, localResourceRoots };

  if (!pdfPanel) {
    pdfPanel = vscode.window.createWebviewPanel(
      "backslashPdf",
      "Backslash PDF",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      webviewOptions
    );
    pdfPanel.onDidDispose(() => {
      pdfPanel = undefined;
    });
  } else {
    pdfPanel.webview.options = webviewOptions;
  }

  const workerUri = vscode.Uri.joinPath(mediaDir, "pdfjs", "pdf.worker.min.mjs");
  const fileWebviewUri = pdfPanel.webview.asWebviewUri(uri);
  const workerWebviewUri = pdfPanel.webview.asWebviewUri(workerUri);

  if (pdfPanel.webview.html.length > 0) {
    // Panel already initialised — just reload the (possibly updated) PDF.
    pdfPanel.webview.postMessage({ type: "load", fileUri: fileWebviewUri.toString() });
    pdfPanel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    pdfPanel.webview.html = await renderViewerHtml(
      pdfPanel.webview,
      extensionUri,
      fileWebviewUri,
      workerWebviewUri
    );
  }
}

module.exports = { tempPdfUri, pullPdf, openPdf };
