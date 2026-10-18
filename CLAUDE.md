# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Tiles a text watermark across an image. Two implementations of the same algorithm: a single-file Python CLI (`watermarkit.py`, OpenCV + numpy) and a static, client-side web app (`web/`, plain ES modules, no build step, no dependencies). There is no lint config; `tests/parity.py` checks the two agree.

## Commands

```bash
pip install -r requirements.txt          # opencv-python (pulls in numpy)
python watermarkit.py <image_path> "<text>" [--des out.jpg] [--size 0.035] [--spacing 1.0] [--strength 0.25] [--mode seamless|flat] [--font font.ttf] [--show]
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY"   # sample images in imgs/
```

```bash
python3 -m http.server -d web 8000      # web app at http://localhost:8000 (module scripts need http, not file://)
python3 tests/parity.py                  # JS blend vs Python on the sample images (needs Node 18+)
```

`--show` previews with `cv.imshow` (needs a display); without it the script runs headless. `--font` renders with Pillow (only imported then) and is required for non-ASCII text such as Chinese; otherwise Hershey `FONT_HERSHEY_SIMPLEX` is used.

## Architecture

Module-level defaults: `SIZE`, `MAX_WIDTH`, `COVERAGE`, `HALO` (in cap heights) and `STRENGTH`. `layout` picks the size and spacing: `cap_h = SIZE * min(image_h, image_w)`, shrunk (to at most half) if one copy is wider than `MAX_WIDTH` of the image; the gap between copies (equal in x and y) is solved so text ink fills `COVERAGE` of each grid cell, times `--spacing`. So density is the same for short and long text.

- `render_tile` rasterises one underlined copy of the text into two float masks: `core` (the text) and `ring` (an outline `HALO` cap heights wide, made by dilating `core`; OpenCV 5's `putText` ignores `thickness`, so don't draw it as a thicker stroke). The tile is the ink bounding box plus a 3px blank margin, grown so `tile_dim - 1` has only factors 2, 3, 5 (FFT-friendly for the solver).
- `tile_positions` lays tiles on a grid centred on the image, odd rows shifted by half a cell, keeping every tile that touches the image (partial edge tiles included). Gaps are at least 2px so tile windows never overlap, which keeps every tile's blend independent.
- `watermarkit_seamless_clone` (default): the guide is `255 * strength * (ring - core)`, dark text with a light outline. `poisson_blend_mixed` solves, per tile, a Poisson equation over the tile rectangle minus its 1px border (clipped to the image interior), with the image as the Dirichlet boundary. For each pixel pair the target difference is the guide's if its magnitude beats the image's (summed over channels), else the image's (mixed gradients). The rectangle is solved exactly with a DST-I (`_solve_poisson_rect`, via `np.fft.rfft`), batched over tiles of the same rectangle size. It does not use `cv.seamlessClone`.
- `watermarkit_put_text` (`--mode flat`): same tile and layout, plain alpha blend of dark text with a light outline.

## Web app (`web/`)

Deployed as static files (Vercel Hobby, project Root Directory `web`); everything runs in the browser.

- `watermark-core.js`: port of the layout, mixed-gradient blend and flat blend; no DOM, so it runs in the worker and in Node. `pyRound` mirrors Python's round-half-even so layouts match exactly. The DST uses a hand-written FFT (mixed radix 2/3/4/5, Bluestein for other lengths, two rows per complex FFT). Keep it in step with `watermarkit.py` and run `tests/parity.py` after changing either.
- `render.js`: draws the tile with canvas text (system fonts, so CJK works) and `strokeText` for the outline. Python's cap height (from `cv.getTextSize`) is about 1/3 taller than its visible capitals, so glyphs are drawn at `GLYPH_CAP * capH`; `FONT_WEIGHT` 800 roughly matches the CLI's ink, which drives the automatic spacing.
- `worker.js` runs the blend; `app.js` is the UI. The live preview works on a copy capped at `PREVIEW_MAX` px; downloads render at full size.

Planned work (from README TODO): Docker runtime, GPU-accelerated Poisson blending, and OCR to avoid overlapping existing text.
