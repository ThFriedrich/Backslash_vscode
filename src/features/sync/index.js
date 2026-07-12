const vscode = require("vscode");
const { cfg, workspaceRoot, MANIFEST_DIR } = require("../../config");
const { api, requireProject } = require("../../api");
const { log, getOutput } = require("../../ui");
const { relOf, hashBytes, isBinaryPath, writeLocalFile } = require("../../util/files");
const { readManifest, writeManifest } = require("./manifest");
const { fetchRemoteList, fetchRemoteContent, pushSpecific } = require("./remote");
const { resolveConflict } = require("./conflict");

const withProgress = (title, task) =>
  vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title },
    task
  );

/**
 * Collect local text files as a `Map(relPath -> bytes)`, honoring the push
 * globs and skipping the manifest folder and binaries.
 */
async function collectLocalFiles() {
  const { include, exclude } = cfg();
  const root = workspaceRoot();
  const uris = await vscode.workspace.findFiles(include, exclude);
  const map = new Map();
  for (const uri of uris) {
    const rel = relOf(root, uri);
    if (rel === MANIFEST_DIR || rel.startsWith(MANIFEST_DIR + "/")) continue;
    if (isBinaryPath(rel)) continue;
    map.set(rel, await vscode.workspace.fs.readFile(uri));
  }
  return map;
}

/** Download the whole project into the workspace and (re)create the manifest. */
async function pullAll(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const list = await fetchRemoteList(context, projectId);
  const manifest = { projectId, lastSync: null, files: {} };
  let pulled = 0;
  let skipped = 0;

  await withProgress("Backslash: Downloading project", async (progress) => {
    for (const f of list) {
      if (isBinaryPath(f.path)) {
        skipped++;
        continue;
      }
      progress.report({ message: f.path });
      const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
      if (isBinaryPath(f.path, mime)) {
        skipped++;
        continue;
      }
      const bytes = new TextEncoder().encode(content);
      await writeLocalFile(root, f.path, bytes);
      manifest.files[f.path] = { fileId: f.id, hash: hashBytes(bytes), size: bytes.length };
      pulled++;
    }
  });

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  log(`Cloned project: ${pulled} file(s) downloaded, ${skipped} binary skipped.`);
  vscode.window.showInformationMessage(
    `Backslash: downloaded ${pulled} file(s) to the workspace.` +
      (skipped ? ` ${skipped} binary file(s) skipped.` : "")
  );
}

/** Push local changes (new + modified + deletions) to the server. */
async function syncPush(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const manifest = await readManifest();
  const local = await collectLocalFiles();
  const remoteList = await fetchRemoteList(context, projectId);
  const remoteByPath = new Map(remoteList.map((f) => [f.path, f]));

  const toPush = [];
  const conflicts = [];

  for (const [rel, bytes] of local) {
    const h = hashBytes(bytes);
    const rec = manifest.files[rel];
    if (rec && rec.hash === h) continue; // unchanged since last sync
    const remote = remoteByPath.get(rel);
    // Only a tracked file can conflict; a brand-new local file just pushes.
    if (rec && remote) {
      const { content } = await fetchRemoteContent(context, projectId, remote.id);
      const remoteHash = hashBytes(new TextEncoder().encode(content));
      if (remoteHash !== rec.hash) {
        conflicts.push({ rel, bytes, remoteContent: content, remote });
        continue;
      }
    }
    toPush.push({ rel, bytes });
  }

  // Files tracked in the manifest but no longer present locally → deletions.
  const deletions = Object.keys(manifest.files).filter(
    (rel) => !local.has(rel) && remoteByPath.has(rel)
  );

  if (!toPush.length && !conflicts.length && !deletions.length) {
    vscode.window.showInformationMessage("Backslash: nothing to push — server is up to date.");
    return;
  }

  for (const c of conflicts) {
    const choice = await resolveConflict(c.rel, c.remoteContent);
    if (choice === "local") {
      toPush.push({ rel: c.rel, bytes: c.bytes });
    } else if (choice === "server") {
      const rbytes = new TextEncoder().encode(c.remoteContent);
      await writeLocalFile(root, c.rel, rbytes);
      manifest.files[c.rel] = { fileId: c.remote.id, hash: hashBytes(rbytes), size: rbytes.length };
    }
    // "skip" leaves the file flagged until the next sync.
  }

  let doDelete = [];
  if (deletions.length) {
    const ans = await vscode.window.showWarningMessage(
      `Delete ${deletions.length} file(s) on the server that were removed locally?\n\n${deletions.join("\n")}`,
      { modal: true },
      "Delete on Server",
      "Keep on Server"
    );
    if (ans === "Delete on Server") doDelete = deletions;
  }

  await withProgress("Backslash: Pushing", async (progress) => {
    if (toPush.length) {
      progress.report({ message: `Uploading ${toPush.length} file(s)…` });
      await pushSpecific(context, projectId, toPush);
      for (const { rel, bytes } of toPush) {
        manifest.files[rel] = {
          fileId: (remoteByPath.get(rel) || {}).id || (manifest.files[rel] || {}).fileId || null,
          hash: hashBytes(bytes),
          size: bytes.length,
        };
      }
    }
    for (const rel of doDelete) {
      progress.report({ message: `Deleting ${rel}…` });
      const remote = remoteByPath.get(rel);
      if (remote) await api(context, "DELETE", `/api/v1/projects/${projectId}/files/${remote.id}`);
      delete manifest.files[rel];
    }
  });

  // New files have no id yet — refresh the server list to capture them.
  const after = await fetchRemoteList(context, projectId);
  const afterByPath = new Map(after.map((f) => [f.path, f]));
  for (const rel of Object.keys(manifest.files)) {
    if (!manifest.files[rel].fileId && afterByPath.has(rel)) {
      manifest.files[rel].fileId = afterByPath.get(rel).id;
    }
  }

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  const parts = [];
  if (toPush.length) parts.push(`${toPush.length} pushed`);
  if (doDelete.length) parts.push(`${doDelete.length} deleted`);
  log(`Sync push: ${parts.join(", ") || "no changes"}.`);
  vscode.window.showInformationMessage(`Backslash push complete — ${parts.join(", ") || "no changes"}.`);
}

/** Pull server changes (new + modified + deletions) into the workspace. */
async function syncPull(context, treeProvider) {
  const projectId = requireProject();
  const root = workspaceRoot();
  const manifest = await readManifest();
  const remoteList = await fetchRemoteList(context, projectId);

  const changes = []; // remote new/modified, local clean
  const conflicts = []; // changed on both sides
  const remotePaths = new Set();

  await withProgress("Backslash: Checking server", async (progress) => {
    for (const f of remoteList) {
      if (isBinaryPath(f.path)) continue;
      progress.report({ message: f.path });
      const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
      if (isBinaryPath(f.path, mime)) continue;
      remotePaths.add(f.path);
      const rbytes = new TextEncoder().encode(content);
      const rhash = hashBytes(rbytes);
      const rec = manifest.files[f.path];
      if (rec && rec.hash === rhash) continue; // server unchanged

      let localHash = null;
      try {
        const lb = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(root, ...f.path.split("/"))
        );
        localHash = hashBytes(lb);
      } catch {
        /* no local copy */
      }

      if (rec && localHash && localHash !== rec.hash) {
        conflicts.push({ rel: f.path, remote: f, content, bytes: rbytes, hash: rhash });
      } else {
        changes.push({ rel: f.path, remote: f, bytes: rbytes, hash: rhash });
      }
    }
  });

  // Tracked files gone from the server → offer to delete the local copy.
  const remoteDeleted = Object.keys(manifest.files).filter(
    (rel) => !remotePaths.has(rel) && !isBinaryPath(rel)
  );

  if (!changes.length && !conflicts.length && !remoteDeleted.length) {
    vscode.window.showInformationMessage("Backslash: nothing to pull — workspace is up to date.");
    return;
  }

  for (const c of conflicts) {
    const choice = await resolveConflict(c.rel, c.content);
    if (choice === "server") changes.push(c); // apply below
    // "local"/"skip": keep local file; leave flagged until pushed.
  }

  let localDelete = [];
  if (remoteDeleted.length) {
    const ans = await vscode.window.showWarningMessage(
      `${remoteDeleted.length} file(s) were deleted on the server. Delete them locally too?\n\n${remoteDeleted.join("\n")}`,
      { modal: true },
      "Delete Locally",
      "Keep Locally"
    );
    if (ans === "Delete Locally") localDelete = remoteDeleted;
  }

  await withProgress("Backslash: Pulling", async (progress) => {
    for (const c of changes) {
      progress.report({ message: c.rel });
      await writeLocalFile(root, c.rel, c.bytes);
      manifest.files[c.rel] = { fileId: c.remote.id, hash: c.hash, size: c.bytes.length };
    }
    for (const rel of localDelete) {
      progress.report({ message: `Deleting ${rel}…` });
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(root, ...rel.split("/")));
      } catch {
        /* already gone */
      }
      delete manifest.files[rel];
    }
  });

  await writeManifest(manifest);
  if (treeProvider) treeProvider.refresh();
  const parts = [];
  if (changes.length) parts.push(`${changes.length} updated`);
  if (localDelete.length) parts.push(`${localDelete.length} removed`);
  log(`Sync pull: ${parts.join(", ") || "no changes"}.`);
  vscode.window.showInformationMessage(`Backslash pull complete — ${parts.join(", ") || "no changes"}.`);
}

/** Print a dry-run summary of pending push/pull changes to the output channel. */
async function syncStatus(context) {
  const projectId = requireProject();
  const manifest = await readManifest();
  const local = await collectLocalFiles();
  const remoteList = await fetchRemoteList(context, projectId);
  const remoteByPath = new Map(remoteList.map((f) => [f.path, f]));
  const remoteHashes = new Map();

  await withProgress("Backslash: Computing status", async () => {
    for (const f of remoteList) {
      if (isBinaryPath(f.path)) continue;
      const { content, mime } = await fetchRemoteContent(context, projectId, f.id);
      if (isBinaryPath(f.path, mime)) continue;
      remoteHashes.set(f.path, hashBytes(new TextEncoder().encode(content)));
    }
  });

  const localOnly = [];
  const localMod = [];
  const remoteOnly = [];
  const remoteMod = [];
  const conflicts = [];
  const localDeleted = [];
  const remoteDeleted = [];

  for (const [rel, bytes] of local) {
    const h = hashBytes(bytes);
    const rec = manifest.files[rel];
    if (!rec) {
      if (!remoteByPath.has(rel)) localOnly.push(rel);
      else localMod.push(rel);
      continue;
    }
    const localChanged = h !== rec.hash;
    const rh = remoteHashes.get(rel);
    const remoteChanged = rh !== undefined && rh !== rec.hash;
    if (localChanged && remoteChanged) conflicts.push(rel);
    else if (localChanged) localMod.push(rel);
  }
  for (const [rel, rh] of remoteHashes) {
    const rec = manifest.files[rel];
    if (!rec) {
      if (!local.has(rel)) remoteOnly.push(rel);
      continue;
    }
    if (!local.has(rel)) {
      if (rh !== rec.hash) remoteMod.push(rel);
    } else if (rh !== rec.hash && hashBytes(local.get(rel)) === rec.hash) {
      remoteMod.push(rel);
    }
  }
  for (const rel of Object.keys(manifest.files)) {
    if (!local.has(rel) && remoteByPath.has(rel)) localDeleted.push(rel);
    if (local.has(rel) && !remoteByPath.has(rel)) remoteDeleted.push(rel);
  }

  const output = getOutput();
  output.clear();
  output.appendLine("Backslash sync status");
  output.appendLine(`Last sync: ${manifest.lastSync || "never"}`);
  const section = (title, arr) => {
    output.appendLine(`\n${title} (${arr.length})`);
    for (const r of arr) output.appendLine(`  ${r}`);
  };
  section("↑ New locally (push)", localOnly);
  section("↑ Modified locally (push)", localMod);
  section("↑ Deleted locally (push removes on server)", localDeleted);
  section("↓ New on server (pull)", remoteOnly);
  section("↓ Modified on server (pull)", remoteMod);
  section("↓ Deleted on server (pull removes locally)", remoteDeleted);
  section("⚠ Conflicts (changed on both sides)", conflicts);
  output.show(true);
}

module.exports = { collectLocalFiles, pullAll, syncPush, syncPull, syncStatus };
