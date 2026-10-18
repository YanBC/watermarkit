# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file Python CLI (`watermarkit.py`) that tiles a text watermark across an image using OpenCV. There is no build, lint config, or test suite.

## Commands

```bash
pip install -r requirements.txt          # opencv-python (pulls in numpy)
python watermarkit.py <image_path> "<text>" [--des out.jpg] [--size 0.035] [--spacing 1.0] [--strength 0.25] [--mode seamless|flat] [--font font.ttf] [--show]
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY"   # sample images in imgs/
```

`--show` previews with `cv.imshow` (needs a display); without it the script runs headless. `--font` renders with Pillow (only imported then) and is required for non-ASCII text such as Chinese; otherwise Hershey `FONT_HERSHEY_SIMPLEX` is used.

## Architecture

Module-level defaults: `SIZE`, `MAX_WIDTH`, `COVERAGE`, `HALO` (in cap heights) and `STRENGTH`. `layout` picks the size and spacing: `cap_h = SIZE * min(image_h, image_w)`, shrunk (to at most half) if one copy is wider than `MAX_WIDTH` of the image; the gap between copies (equal in x and y) is solved so text ink fills `COVERAGE` of each grid cell, times `--spacing`. So density is the same for short and long text.

- `render_tile` rasterises one underlined copy of the text into two float masks: `core` (the text) and `ring` (an outline `HALO` cap heights wide). The tile is the ink bounding box plus a 3px blank margin, grown so `tile_dim - 1` has only factors 2, 3, 5 (FFT-friendly for the solver).
- `tile_positions` lays tiles on a grid centred on the image, odd rows shifted by half a cell, keeping every tile that touches the image (partial edge tiles included). Gaps are at least 2px so tile windows never overlap, which keeps every tile's blend independent.
- `watermarkit_seamless_clone` (default): the guide is `255 * strength * (ring - core)`, dark text with a light outline. `poisson_blend_mixed` solves, per tile, a Poisson equation over the tile rectangle minus its 1px border (clipped to the image interior), with the image as the Dirichlet boundary. For each pixel pair the target difference is the guide's if its magnitude beats the image's (summed over channels), else the image's (mixed gradients). The rectangle is solved exactly with a DST-I (`_solve_poisson_rect`, via `np.fft.rfft`), batched over tiles of the same rectangle size. It does not use `cv.seamlessClone`.
- `watermarkit_put_text` (`--mode flat`): same tile and layout, plain alpha blend of dark text with a light outline.

Planned work (from README TODO): web UI (client-side, static hosting; the blend is meant to port to plain JS), Docker runtime, GPU-accelerated Poisson blending, and OCR to avoid overlapping existing text.
