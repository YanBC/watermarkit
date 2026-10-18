// Text rasterisation for the watermark tile, with the browser's canvas text,
// so any installed font (including Chinese) works.
import { HALO, cropTile, pyRound } from "./watermark-core.js";

export const FONT_FAMILY =
  'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, ' +
  '"PingFang HK", "PingFang TC", "Hiragino Sans", "Microsoft JhengHei", ' +
  '"Noto Sans CJK TC", "Noto Sans TC", sans-serif';

// watermarkit.py's cap height comes from cv.getTextSize, which is about 1/3
// taller than the visible capitals of its Hershey font. Glyphs here are drawn
// with capitals GLYPH_CAP * capH tall so both versions look the same size.
const GLYPH_CAP = 0.75;
const FONT_WEIGHT = 800;

const canvas = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : document.createElement("canvas");
const ctx = canvas.getContext("2d", { willReadFrequently: true });

// One underlined copy of the text with cap height capH, cropped (see cropTile).
export function renderTile(text, capH) {
  const thickness = Math.max(1, pyRound(capH / 12));
  const halo = Math.max(1, pyRound(capH * HALO));
  const margin = halo + thickness + 4;

  ctx.font = `${FONT_WEIGHT} 100px ${FONT_FAMILY}`;
  const probe = ctx.measureText("H");
  const font = `${FONT_WEIGHT} ${(100 * GLYPH_CAP * capH) / (probe.actualBoundingBoxAscent + probe.actualBoundingBoxDescent)}px ${FONT_FAMILY}`;
  ctx.font = font;
  const m = ctx.measureText(text);
  const left = Math.ceil(m.actualBoundingBoxLeft);
  const textW = left + Math.ceil(m.actualBoundingBoxRight);
  const ascent = Math.ceil(m.actualBoundingBoxAscent);
  const underY = 2 * thickness;
  const bottom = Math.max(Math.ceil(m.actualBoundingBoxDescent), underY + thickness);
  const w = textW + 2 * margin;
  const h = ascent + bottom + 2 * margin;
  canvas.width = w;
  canvas.height = h;
  const ox = margin + left;
  const oy = margin + ascent;

  const draw = (extra) => {
    ctx.clearRect(0, 0, w, h);
    ctx.font = font;
    ctx.fillStyle = ctx.strokeStyle = "#fff";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (extra) {
      ctx.lineWidth = 2 * extra;
      ctx.strokeText(text, ox, oy);
    }
    ctx.fillText(text, ox, oy);
    ctx.lineWidth = thickness + 2 * extra;
    ctx.beginPath();
    ctx.moveTo(margin, oy + underY + thickness / 2);
    ctx.lineTo(margin + textW, oy + underY + thickness / 2);
    ctx.stroke();
    const px = ctx.getImageData(0, 0, w, h).data;
    const a = new Float32Array(w * h);
    for (let i = 0; i < a.length; i++) a[i] = px[i * 4 + 3] / 255;
    return a;
  };
  const core = draw(0);
  const ring = draw(halo);
  for (let i = 0; i < ring.length; i++) ring[i] = Math.max(ring[i] - core[i], 0);
  return cropTile(core, ring, w, h);
}
