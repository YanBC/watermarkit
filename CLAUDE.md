# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A single-file Python CLI (`watermarkit.py`) that tiles a text watermark across an image using OpenCV. There is no build, lint config, or test suite.

## Commands

```bash
pip install -r requirements.txt          # opencv-python (pulls in numpy)
python watermarkit.py <image_path> "<text>" [--des out.jpg]
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY"   # sample image in imgs/
```

The script calls `cv.imshow` + `cv.waitKey()` before saving, so it blocks until a key is pressed in the preview window and needs a display. For headless runs or scripted checks, import the functions instead of running `__main__`.

## Architecture

Two watermarking strategies share the same tiling layout:

- Text size comes from `cv.getTextSize` with `FONT_HERSHEY_SIMPLEX`; each grid cell is `text_w * SCALE_FACTOR_W` by `text_h * SCALE_FACTOR_H` (module-level globals, both must be > 1). One copy of the text, underlined, is drawn centred in each cell via `write_text_at_centre`.
- `watermarkit_put_text`: draws text directly onto the image in a fixed light color. Uses `image_dim // grid + 1` cells, so tiles may run past the edges (clipped by OpenCV).
- `watermarkit_seamless_clone` (the one `__main__` uses): renders one white-on-black tile plus a rectangular text mask with `generate_watermark_gray`, then Poisson-blends it into every cell with `cv.seamlessClone(..., cv.MIXED_CLONE)` so the watermark picks up the local image texture. The tile is exactly one grid cell in size, and `seamlessClone` fails if the patch extends past the destination, so this path uses `image_dim // grid` cells (floor, no `+1`). Keep that in mind when changing the grid math or scale factors.

Planned work (from README TODO): web UI, Docker runtime, Chinese font support (Hershey fonts are ASCII-only), GPU-accelerated Poisson blending, and OCR to avoid overlapping existing text.
