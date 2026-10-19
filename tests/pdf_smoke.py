"""Smoke-test the CLI's PDF path: watermark a sample PDF end to end.

Builds a two-page PDF from the sample images, runs watermarkit.py on it as a
subprocess, and checks the output is a valid PDF whose pages carry the
watermark. Needs pypdfium2 and Pillow.

    python tests/pdf_smoke.py
"""
import os
import subprocess
import sys
import tempfile

import cv2 as cv
import numpy as np
import pypdfium2 as pdfium
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..")
DPI = 150


def main():
    cli = os.path.join(ROOT, "watermarkit.py")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "sample.pdf")
        pages = [Image.open(os.path.join(ROOT, path)).convert("RGB")
                 for path in ("imgs/demo_id.jpg", "imgs/rem.jpg")]
        pages[0].save(src, save_all=True, append_images=[pages[1]], resolution=float(DPI))

        des = os.path.join(tmp, "out.pdf")
        r = subprocess.run([sys.executable, cli, src, "FOR VERIFICATION ONLY", "--des", des],
                           capture_output=True, text=True)
        print(r.stderr, end="")
        assert r.returncode == 0, f"CLI failed: {r.stdout}"
        assert os.path.exists(des), "no output written"

        out = pdfium.PdfDocument(des)
        assert len(out) == 2, f"expected 2 pages, got {len(out)}"
        for k, page in enumerate(out):
            src_pt = pages[k].size
            # The page is rasterised at DPI, so its size may round up by under 1 pt.
            assert abs(page.get_size()[0] - src_pt[0] * 72 / DPI) < 1, \
                f"page {k} width {page.get_size()[0]:.1f} pt does not match the source"

        # Page 1 must have changed exactly where the watermark layout puts its
        # tiles, and barely elsewhere (only the JPEG round-trip's noise). Both
        # renders are blurred first: page sizes may differ by a pixel, and the
        # resulting sub-pixel stretch lights up fine textures like guilloche.
        sys.path.insert(0, ROOT)
        import watermarkit as wm
        got = out[0].render(scale=DPI / 72).to_numpy()[..., :3]
        base = pdfium.PdfDocument(src)[0].render(scale=DPI / 72).to_numpy()[..., :3]
        base = cv.resize(base, (got.shape[1], got.shape[0]))
        blur = lambda a: cv.GaussianBlur(a, (13, 13), 2)
        core, _ring, positions = wm.layout(got.shape, "FOR VERIFICATION ONLY")
        ink = np.zeros(got.shape[:2], bool)
        th, tw = core.shape
        for x, y in positions:
            y0, x0 = max(y, 0), max(x, 0)
            y1, x1 = min(y + th, got.shape[0]), min(x + tw, got.shape[1])
            if y1 > y0 and x1 > x0:
                ink[y0:y1, x0:x1] |= core[y0 - y:y1 - y, x0 - x:x1 - x] > 0
        d = cv.absdiff(blur(got), blur(base)).mean(axis=2)
        inside, outside = float(d[ink].mean()), float(d[~ink].mean())
        assert inside > 10 and inside > 5 * outside, \
            f"watermark missing or misplaced: diff on ink {inside:.1f} vs off ink {outside:.1f}"
        print(f"pdf smoke ok: 2 pages, diff on ink {inside:.1f} vs off ink {outside:.1f}")


if __name__ == "__main__":
    main()
