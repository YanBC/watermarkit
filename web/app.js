import { layout } from "./watermark-core.js";
import { renderTile } from "./render.js";

// Live preview runs on a copy no larger than this; downloads use full size.
// Size and spacing are relative to the image, so both look the same.
const PREVIEW_MAX = 1600;
const PDF_DPI = 150;            // pages are rasterised at this resolution for download
const PDF_MAX_PIXELS = 24e6;    // cap on a rasterised page's area, ~6000 × 4000

const $ = (id) => document.getElementById(id);
const fileInput = $("file");
const textInput = $("text");
const sliders = { size: $("size"), spacing: $("spacing"), strength: $("strength") };
const downloadButton = $("download");
const statusLine = $("status");
const stage = $("stage");
const view = $("view");
const viewCtx = view.getContext("2d");
const compareButton = $("compare");

let source = null;        // { kind: "image" | "pdf", name, dims, pageLabel?, bitmap? | pdf? }
let previewBase = null;   // ImageData of the downscaled original
let previewResult = null; // ImageData of the watermarked preview
let showingOriginal = false;

function settings() {
  return {
    text: textInput.value,
    size: sliders.size.valueAsNumber / 100,
    spacing: sliders.spacing.valueAsNumber,
    strength: sliders.strength.valueAsNumber / 100,
    mode: document.querySelector('input[name="mode"]:checked').value,
  };
}

function showValues() {
  $("size-out").textContent = `${sliders.size.valueAsNumber.toFixed(1)}%`;
  $("spacing-out").textContent = `×${sliders.spacing.valueAsNumber.toFixed(1)}`;
  $("strength-out").textContent = `${sliders.strength.value}%`;
}

function setStatus(message) {
  statusLine.textContent = message;
}

// --- worker ----------------------------------------------------------------

const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const jobs = new Map();
let nextJob = 0;
worker.onmessage = (e) => {
  jobs.get(e.data.id).resolve(e.data);
  jobs.delete(e.data.id);
};
worker.onerror = (e) => {
  for (const job of jobs.values()) job.reject(e);
  jobs.clear();
};

// Watermark a copy of imageData. Resolves to { imageData, ms, copies }.
function watermark(imageData, s) {
  const { width, height } = imageData;
  if (!s.text.trim()) {
    return Promise.resolve({ imageData: new ImageData(imageData.data.slice(), width, height), ms: 0, copies: 0 });
  }
  const { tile, positions } = layout(width, height, (capH) => renderTile(s.text, capH), s);
  const rgba = imageData.data.slice().buffer;
  return new Promise((resolve, reject) => {
    const id = nextJob++;
    jobs.set(id, {
      resolve: (d) => resolve({ imageData: new ImageData(new Uint8ClampedArray(d.rgba), width, height), ms: d.ms, copies: positions.length }),
      reject,
    });
    worker.postMessage({ id, rgba, width, height, tile, positions, strength: s.strength, mode: s.mode }, [rgba]);
  });
}

// --- preview ---------------------------------------------------------------

let busy = false;
let dirty = false;

async function refresh() {
  if (!previewBase) return;
  if (busy) {
    dirty = true;
    return;
  }
  busy = true;
  do {
    dirty = false;
    const s = settings();
    try {
      const result = await watermark(previewBase, s);
      previewResult = result.imageData;
      if (!showingOriginal) viewCtx.putImageData(previewResult, 0, 0);
      const { width, height } = source.dims;
      setStatus(s.text.trim()
        ? `${width} × ${height} · ${result.copies} copies · preview in ${Math.round(result.ms)} ms${source.pageLabel || ""}`
        : "Enter some text to watermark with.");
    } catch (err) {
      console.error(err);
      setStatus("Something went wrong while rendering the preview.");
    }
  } while (dirty);
  busy = false;
}

async function loadFile(file) {
  const isPdf = file && (file.type === "application/pdf" || /\.pdf$/i.test(file.name || ""));
  if (!file || (!isPdf && !file.type.startsWith("image/"))) {
    setStatus("That file is not an image or PDF.");
    return;
  }
  if (isPdf) return loadPdf(file);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (err) {
    console.error(err);
    setStatus("Could not read this image.");
    return;
  }
  releaseSource();
  source = {
    kind: "image",
    bitmap,
    name: file.name.replace(/\.[^.]+$/, "") || "image",
    type: file.type,
    dims: { width: bitmap.width, height: bitmap.height },
  };

  const scale = Math.min(1, PREVIEW_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  view.width = w;
  view.height = h;
  viewCtx.imageSmoothingQuality = "high";
  viewCtx.drawImage(bitmap, 0, 0, w, h);
  previewBase = viewCtx.getImageData(0, 0, w, h);
  previewResult = previewBase;
  revealPreview();
}

// Renders page 1 of a PDF into the preview. The whole document is kept around
// for the download; only the first page is shown, the settings apply to all.
async function loadPdf(file) {
  setStatus("Reading PDF…");
  let pdf;
  try {
    const pdfjs = await import("./vendor/pdf.min.mjs");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL("./vendor/pdf.worker.min.mjs", import.meta.url).href;
    pdf = await pdfjs.getDocument({
      data: await file.arrayBuffer(),
      cMapUrl: new URL("./vendor/cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL("./vendor/standard_fonts/", import.meta.url).href,
    }).promise;
  } catch (err) {
    console.error(err);
    setStatus(err?.name === "PasswordException" ? "This PDF is password-protected." : "Could not read this PDF.");
    return;
  }
  try {
    const page = await pdf.getPage(1);
    // PDF pages are vector, so the preview is rendered crisply at any scale.
    const base = page.getViewport({ scale: 1 });
    const scale = PREVIEW_MAX / Math.max(base.width, base.height);
    const viewport = page.getViewport({ scale });
    view.width = viewport.width;
    view.height = viewport.height;
    await page.render({ canvasContext: viewCtx, viewport }).promise;
    releaseSource();
    source = {
      kind: "pdf",
      pdf,
      name: file.name.replace(/\.[^.]+$/, "") || "document",
      pageCount: pdf.numPages,
      dims: { width: view.width, height: view.height },
      pageLabel: ` · page 1 of ${pdf.numPages}`,
    };
    previewBase = viewCtx.getImageData(0, 0, view.width, view.height);
    previewResult = previewBase;
  } catch (err) {
    console.error(err);
    pdf.destroy();
    setStatus("Could not render this PDF.");
    return;
  }
  revealPreview();
}

function releaseSource() {
  source?.bitmap?.close();
  source?.pdf?.destroy();
}

function revealPreview() {
  $("empty").hidden = true;
  view.hidden = false;
  compareButton.hidden = false;
  downloadButton.disabled = false;
  refresh();
}

// --- download --------------------------------------------------------------

async function download() {
  if (!source) return;
  const s = settings();
  downloadButton.disabled = true;
  try {
    if (source.kind === "pdf") await downloadPdf(s);
    else await downloadImage(s);
  } catch (err) {
    console.error(err);
    setStatus("Could not render the full-size output. It may be too large for this browser.");
  } finally {
    downloadButton.disabled = false;
  }
}

async function downloadImage(s) {
  const { bitmap } = source;
  setStatus(`Rendering full size (${bitmap.width} × ${bitmap.height})…`);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0);
  const result = await watermark(ctx.getImageData(0, 0, canvas.width, canvas.height), s);
  ctx.putImageData(result.imageData, 0, 0);

  const type = source.type === "image/png" || source.type === "image/webp" ? source.type : "image/jpeg";
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
  const filename = `${source.name}-watermarked.${type.split("/")[1].replace("jpeg", "jpg")}`;
  saveBlob(blob, filename);
  setStatus(`Saved ${filename} (${(result.ms / 1000).toFixed(1)} s).`);
}

// Rasterises every page at PDF_DPI, watermarks each with the same blend as an
// image, and reassembles them into a PDF. Pages are processed one at a time to
// bound memory.
async function downloadPdf(s) {
  const { pdf, pageCount, name } = source;
  const started = performance.now();
  const out = await PDFLib.PDFDocument.create();
  for (let n = 1; n <= pageCount; n++) {
    setStatus(`Watermarking page ${n} of ${pageCount}…`);
    const page = await pdf.getPage(n);
    let scale = PDF_DPI / 72;
    const base = page.getViewport({ scale: 1 });
    const pixels = base.width * base.height * scale * scale;
    if (pixels > PDF_MAX_PIXELS) scale *= Math.sqrt(PDF_MAX_PIXELS / pixels);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    const result = await watermark(ctx.getImageData(0, 0, canvas.width, canvas.height), s);
    ctx.putImageData(result.imageData, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    page.cleanup();

    const wPt = canvas.width / scale, hPt = canvas.height / scale;
    const img = await out.embedJpg(await blob.arrayBuffer());
    out.addPage([wPt, hPt]).drawImage(img, { x: 0, y: 0, width: wPt, height: hPt });
  }
  setStatus("Assembling PDF…");
  const filename = `${name}-watermarked.pdf`;
  const blob = new Blob([await out.save()], { type: "application/pdf" });
  saveBlob(blob, filename);
  setStatus(`Saved ${filename} (${pageCount} page${pageCount > 1 ? "s" : ""} in ${((performance.now() - started) / 1000).toFixed(1)} s).`);
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// --- events ----------------------------------------------------------------

fileInput.addEventListener("change", () => loadFile(fileInput.files[0]));
textInput.addEventListener("input", refresh);
for (const el of Object.values(sliders)) {
  el.addEventListener("input", () => {
    showValues();
    refresh();
  });
}
for (const el of document.querySelectorAll('input[name="mode"]')) el.addEventListener("change", refresh);
downloadButton.addEventListener("click", download);

const showOriginal = (on) => {
  showingOriginal = on;
  const data = on ? previewBase : previewResult;
  if (data) viewCtx.putImageData(data, 0, 0);
};
compareButton.addEventListener("pointerdown", (e) => {
  compareButton.setPointerCapture(e.pointerId);
  showOriginal(true);
});
for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
  compareButton.addEventListener(type, () => showOriginal(false));
}
compareButton.addEventListener("keydown", (e) => {
  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    showOriginal(true);
  }
});
compareButton.addEventListener("keyup", () => showOriginal(false));

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  stage.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) stage.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  stage.classList.remove("dragging");
  loadFile(e.dataTransfer.files[0]);
});
window.addEventListener("paste", (e) => {
  const item = [...e.clipboardData.items].find((i) => i.type.startsWith("image/"));
  if (item) loadFile(item.getAsFile());
});

showValues();
