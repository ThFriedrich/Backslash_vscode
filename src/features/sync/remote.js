const { api } = require("../../api");

/** Flat list of non-directory server files: `[{ path, id, sizeBytes }]`. */
async function fetchRemoteList(context, projectId) {
  const data = await api(context, "GET", `/api/v1/projects/${projectId}/files`);
  const raw = data.files || data.entries || data || [];
  return raw
    .map((f) => (typeof f === "string" ? { path: f } : f))
    .filter((f) => f && f.path && f.isDirectory !== true);
}

/** Fetch a single remote file's `{ content, mime }` (content is UTF-8 text). */
async function fetchRemoteContent(context, projectId, fileId) {
  const data = await api(context, "GET", `/api/v1/projects/${projectId}/files/${fileId}`);
  return {
    content: typeof data.content === "string" ? data.content : "",
    mime: (data.file && data.file.mimeType) || "",
  };
}

/** Upload a specific set of `{ rel, bytes }` files in one multipart request. */
async function pushSpecific(context, projectId, files) {
  if (!files.length) return;
  const form = new FormData();
  for (const { rel, bytes } of files) {
    form.append("files", new Blob([bytes]), rel);
    form.append("paths", rel);
  }
  await api(context, "POST", `/api/v1/projects/${projectId}/files/upload`, { body: form });
}

module.exports = { fetchRemoteList, fetchRemoteContent, pushSpecific };
