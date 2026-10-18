"""Check that web/watermark-core.js blends exactly like watermarkit.py.

Feeds both the same image, tile masks and positions (the tile comes from the
Python renderer, since fonts differ between Python and the browser) and
compares the results. Needs Node 18+.

    python tests/parity.py
"""
import json
import os
import subprocess
import sys
import tempfile

import cv2 as cv
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import watermarkit as wm  # noqa: E402

CASES = [("imgs/rem.jpg", "FOR VERIFICATION ONLY", 1.0),
         ("imgs/demo_id.jpg", "FOR VERIFICATION ONLY", 1.0),
         ("imgs/rem.jpg", "DRAFT", 0.5)]


def rgba(bgr):
    return np.dstack([bgr[..., ::-1], np.full(bgr.shape[:2], 255, np.uint8)])


def main():
    root = os.path.join(os.path.dirname(__file__), "..")
    with tempfile.TemporaryDirectory() as tmp:
        meta = []
        for k, (path, text, spacing) in enumerate(CASES):
            img = cv.imread(os.path.join(root, path))
            core, ring, positions = wm.layout(img.shape, text, spacing=spacing)
            rgba(img).tofile(f"{tmp}/img{k}.rgba")
            core.tofile(f"{tmp}/core{k}.f32")
            ring.tofile(f"{tmp}/ring{k}.f32")
            rgba(wm.watermarkit_seamless_clone(img, text, spacing=spacing)).tofile(f"{tmp}/seamless{k}.rgba")
            rgba(wm.watermarkit_put_text(img, text, spacing=spacing)).tofile(f"{tmp}/flat{k}.rgba")
            meta.append(dict(name=f"{path} {text!r}", width=img.shape[1], height=img.shape[0], spacing=spacing,
                             tile_w=core.shape[1], tile_h=core.shape[0],
                             positions=[[int(x), int(y)] for x, y in positions]))
        with open(f"{tmp}/meta.json", "w") as f:
            json.dump(meta, f)
        sys.exit(subprocess.call(["node", os.path.join(os.path.dirname(__file__), "parity.mjs"), tmp]))


if __name__ == "__main__":
    main()
