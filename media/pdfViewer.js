// Self-contained PDF viewer for the Backslash webview.
// Renders with pdf.js and provides an Overleaf-like toolbar: page navigation,
// zoom in/out, fit-width and fit-page. Resource URIs are injected by the
// extension via the global `BACKSLASH` object so they resolve to webview-safe
// URIs (allowing files from outside the workspace, e.g. /tmp).

import * as pdfjsLib from "./pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = window.BACKSLASH.workerUri;

const vscodeApi = acquireVsCodeApi();
const container = document.getElementById("viewer");
const statusEl = document.getElementById("status");

// Toolbar elements
const btnPrev = document.getElementById("prev");
const btnNext = document.getElementById("next");
const pageInput = document.getElementById("pageInput");
const pageCount = document.getElementById("pageCount");
const btnZoomOut = document.getElementById("zoomOut");
const btnZoomIn = document.getElementById("zoomIn");
const zoomLabel = document.getElementById("zoomLabel");
const btnFitWidth = document.getElementById("fitWidth");
const btnFitPage = document.getElementById("fitPage");

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const ZOOM_STEP = 0.2;

let pdfDoc = null;
let renderToken = 0;
let currentUrl = null;

// "custom" uses `scale`; "fit-width"/"fit-page" recompute scale on render/resize.
let zoomMode = "fit-width";
let scale = 1.5;
let currentPage = 1;
let pageViews = []; // { wrapper, canvas, baseWidth, baseHeight } per page (1-indexed at [n-1])

function setStatus(msg, isError) {
  statusEl.textContent = msg || "";
  statusEl.className = isError ? "error" : "";
  statusEl.style.display = msg ? "block" : "none";
}

function clampScale(s) {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

function updateZoomLabel() {
  zoomLabel.textContent = Math.round(scale * 100) + "%";
}

function updatePageIndicator() {
  pageInput.value = String(currentPage);
  btnPrev.disabled = currentPage <= 1;
  btnNext.disabled = pdfDoc ? currentPage >= pdfDoc.numPages : true;
}

// Compute the effective scale for the active fit mode using the first page's
// intrinsic (scale-1) dimensions.
function computeFitScale(baseWidth, baseHeight) {
  const styles = getComputedStyle(container);
  const padX =
    parseFloat(styles.paddingLeft || "0") + parseFloat(styles.paddingRight || "0");
  const padY =
    parseFloat(styles.paddingTop || "0") + parseFloat(styles.paddingBottom || "0");
  const availWidth = container.clientWidth - padX - 24; // 24 ~ page margin/shadow
  const availHeight = container.clientHeight - padY - 24;
  if (zoomMode === "fit-width") {
    return clampScale(availWidth / baseWidth);
  }
  if (zoomMode === "fit-page") {
    return clampScale(Math.min(availWidth / baseWidth, availHeight / baseHeight));
  }
  return scale;
}

async function renderAll() {
  if (!pdfDoc) return;
  const token = ++renderToken;

  const prevScroll = container.scrollTop;
  const prevHeight = container.scrollHeight || 1;

  container.innerHTML = "";
  pageViews = [];

  // Use the first page to derive fit scaling.
  const firstPage = await pdfDoc.getPage(1);
  if (token !== renderToken) return;
  const base = firstPage.getViewport({ scale: 1 });
  if (zoomMode !== "custom") {
    scale = computeFitScale(base.width, base.height);
  }
  updateZoomLabel();

  const ratio = window.devicePixelRatio || 1;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = pageNum === 1 ? firstPage : await pdfDoc.getPage(pageNum);
    if (token !== renderToken) return;

    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement("div");
    wrapper.className = "page-wrapper";
    wrapper.dataset.page = String(pageNum);

    const canvas = document.createElement("canvas");
    canvas.className = "page";
    const ctx = canvas.getContext("2d");
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = Math.floor(viewport.width) + "px";
    canvas.style.height = Math.floor(viewport.height) + "px";
    wrapper.appendChild(canvas);
    container.appendChild(wrapper);
    pageViews.push({ wrapper, canvas });

    await page.render({
      canvasContext: ctx,
      viewport,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
    }).promise;
    if (token !== renderToken) return;
  }

  // Restore approximate scroll position after re-render.
  const newHeight = container.scrollHeight || 1;
  container.scrollTop = prevScroll * (newHeight / prevHeight);
  updatePageIndicator();
}

async function loadPdf(url) {
  currentUrl = url;
  const token = ++renderToken;
  setStatus("Loading PDF…");
  try {
    // Cache-bust so a recompiled PDF at the same path is re-fetched.
    const bust = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
    const task = pdfjsLib.getDocument({ url: bust });
    const pdf = await task.promise;
    if (token !== renderToken) return;
    pdfDoc = pdf;
    pageCount.textContent = "/ " + pdf.numPages;
    currentPage = Math.min(currentPage, pdf.numPages);
    await renderAll();
    setStatus("");
  } catch (err) {
    setStatus("Failed to load PDF: " + (err && err.message ? err.message : err), true);
  }
}

// ─── Navigation ──────────────────────────────────────────────────────

function scrollToPage(n) {
  const view = pageViews[n - 1];
  if (view) {
    container.scrollTop = view.wrapper.offsetTop - 8;
  }
}

function goToPage(n) {
  if (!pdfDoc) return;
  const target = Math.min(Math.max(1, n), pdfDoc.numPages);
  currentPage = target;
  scrollToPage(target);
  updatePageIndicator();
}

// Track the page currently in view based on scroll position.
function onScroll() {
  if (!pageViews.length) return;
  const mid = container.scrollTop + container.clientHeight / 2;
  let best = 1;
  for (let i = 0; i < pageViews.length; i++) {
    if (pageViews[i].wrapper.offsetTop <= mid) best = i + 1;
    else break;
  }
  if (best !== currentPage) {
    currentPage = best;
    updatePageIndicator();
  }
}

// ─── Zoom ────────────────────────────────────────────────────────────

let rerenderTimer = null;
function scheduleRender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => renderAll(), 60);
}

function setScale(newScale) {
  zoomMode = "custom";
  scale = clampScale(newScale);
  updateZoomLabel();
  scheduleRender();
}

function setZoomMode(mode) {
  zoomMode = mode;
  btnFitWidth.classList.toggle("active", mode === "fit-width");
  btnFitPage.classList.toggle("active", mode === "fit-page");
  scheduleRender();
}

// ─── Events ──────────────────────────────────────────────────────────

btnPrev.addEventListener("click", () => goToPage(currentPage - 1));
btnNext.addEventListener("click", () => goToPage(currentPage + 1));
pageInput.addEventListener("change", () => {
  const n = parseInt(pageInput.value, 10);
  if (!Number.isNaN(n)) goToPage(n);
});
btnZoomIn.addEventListener("click", () => setScale(scale + ZOOM_STEP));
btnZoomOut.addEventListener("click", () => setScale(scale - ZOOM_STEP));
btnFitWidth.addEventListener("click", () => setZoomMode("fit-width"));
btnFitPage.addEventListener("click", () => setZoomMode("fit-page"));

container.addEventListener("scroll", onScroll, { passive: true });

// Ctrl/Cmd + wheel to zoom.
container.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setScale(scale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }
  },
  { passive: false }
);

// Keyboard shortcuts.
window.addEventListener("keydown", (e) => {
  if (e.target === pageInput) return;
  if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
    e.preventDefault();
    setScale(scale + ZOOM_STEP);
  } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
    e.preventDefault();
    setScale(scale - ZOOM_STEP);
  } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
    e.preventDefault();
    setZoomMode("fit-width");
  } else if (e.key === "PageDown" || (e.key === "ArrowRight" && !e.shiftKey)) {
    goToPage(currentPage + 1);
  } else if (e.key === "PageUp" || (e.key === "ArrowLeft" && !e.shiftKey)) {
    goToPage(currentPage - 1);
  }
});

// Re-fit on resize when in a fit mode.
let resizeTimer = null;
window.addEventListener("resize", () => {
  if (zoomMode === "custom") return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderAll(), 120);
});

// Messages from the extension (e.g. reload after a recompile).
window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg && msg.type === "load" && msg.fileUri) {
    loadPdf(msg.fileUri);
  }
});

// Initial load.
setZoomMode("fit-width");
if (window.BACKSLASH.fileUri) {
  loadPdf(window.BACKSLASH.fileUri);
}
vscodeApi.postMessage({ type: "ready" });
