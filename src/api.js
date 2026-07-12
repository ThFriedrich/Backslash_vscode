const vscode = require("vscode");
const { cfg, SECRET_KEY } = require("./config");

/**
 * Prompt for and securely store the Backslash API key. Returns the stored key,
 * or undefined if the user cancelled.
 */
async function setApiKey(context) {
  const key = await vscode.window.showInputBox({
    prompt: "Enter your Backslash API key (Dashboard → Developer Settings)",
    password: true,
    ignoreFocusOut: true,
    placeHolder: "bs_...",
    validateInput: (v) =>
      v && v.trim().startsWith("bs_") ? undefined : "Key must start with 'bs_'",
  });
  if (!key) return undefined;
  await context.secrets.store(SECRET_KEY, key.trim());
  vscode.window.showInformationMessage("Backslash API key saved.");
  return key.trim();
}

/** Remove the stored API key. */
async function clearApiKey(context) {
  await context.secrets.delete(SECRET_KEY);
  vscode.window.showInformationMessage("Backslash API key cleared.");
}

/** Return the stored key, prompting for one if none is set. Throws if refused. */
async function requireKey(context) {
  let key = await context.secrets.get(SECRET_KEY);
  if (!key) key = await setApiKey(context);
  if (!key) throw new Error("No API key set.");
  return key;
}

/** Return the linked project id, or throw with a helpful message. */
function requireProject() {
  const { projectId } = cfg();
  if (!projectId) {
    throw new Error('No project linked. Run "Backslash: Select Project".');
  }
  return projectId;
}

/**
 * Perform an authenticated request against the Backslash REST API.
 *
 * @param {*} context extension context (for the stored key)
 * @param {string} method HTTP method
 * @param {string} endpoint path beginning with "/"
 * @param {{ headers?: object, body?: any, raw?: boolean }} [opts]
 *   When `raw` is set the raw Response is returned; otherwise the parsed JSON
 *   body is returned and non-2xx responses throw.
 */
async function api(context, method, endpoint, opts = {}) {
  const { serverUrl } = cfg();
  const key = await requireKey(context);
  const res = await fetch(serverUrl + endpoint, {
    method,
    headers: { Authorization: `Bearer ${key}`, ...(opts.headers || {}) },
    body: opts.body,
  });
  if (opts.raw) return res;

  const text = await res.text();
  let json = {};
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
  }
  if (!res.ok) {
    throw new Error((json && (json.message || json.error)) || `HTTP ${res.status}`);
  }
  return json;
}

module.exports = { setApiKey, clearApiKey, requireKey, requireProject, api };
