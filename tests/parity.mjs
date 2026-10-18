// Driven by parity.py: blends its fixtures with the JS port and compares.
import fs from "fs";
import { blendFlat, blendSeamless, layout } from "../web/watermark-core.js";

const dir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`));
const read = (name) => fs.readFileSync(`${dir}/${name}`);
const f32 = (name) => {
  const b = read(name);
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};

let failed = false;
meta.forEach((m, k) => {
  const tile = { core: f32(`core${k}.f32`), ring: f32(`ring${k}.f32`), w: m.tile_w, h: m.tile_h };
  const { positions } = layout(m.width, m.height, () => tile, { spacing: m.spacing });
  const layoutOk = JSON.stringify(positions) === JSON.stringify(m.positions);
  for (const [mode, blend] of [["seamless", blendSeamless], ["flat", blendFlat]]) {
    const img = new Uint8ClampedArray(read(`img${k}.rgba`));
    const ref = new Uint8ClampedArray(read(`${mode}${k}.rgba`));
    blend(img, m.width, m.height, tile, m.positions);
    let maxDiff = 0;
    for (let i = 0; i < img.length; i++) maxDiff = Math.max(maxDiff, Math.abs(img[i] - ref[i]));
    // Python works in float32 and JS in float64, so a few values round differently.
    const ok = layoutOk && maxDiff <= 1;
    failed ||= !ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${m.name} ${mode}: layout ${layoutOk ? "matches" : "differs"}, max diff ${maxDiff}`);
  }
});
process.exit(failed ? 1 : 0);
