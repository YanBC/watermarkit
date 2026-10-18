// Runs the blend off the main thread. The pixel buffer is transferred both ways.
import { blendFlat, blendSeamless } from "./watermark-core.js";

self.onmessage = (e) => {
  const { id, rgba, width, height, tile, positions, strength, mode } = e.data;
  const data = new Uint8ClampedArray(rgba);
  const start = performance.now();
  (mode === "flat" ? blendFlat : blendSeamless)(data, width, height, tile, positions, strength);
  self.postMessage({ id, rgba: data.buffer, ms: performance.now() - start }, [data.buffer]);
};
