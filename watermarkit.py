import argparse
import os

import cv2 as cv
import numpy as np
from typing import List, Tuple


FONT = cv.FONT_HERSHEY_SIMPLEX

# Defaults; everything else is derived from the text cap height.
SIZE = 0.035        # cap height as a fraction of the image's shorter side
MAX_WIDTH = 0.8     # text is shrunk (to at most half size) if one copy would be wider than this fraction of the image
COVERAGE = 0.045    # gaps are chosen so text ink fills about this fraction of the image
HALO = 0.15         # light outline width, in cap heights
STRENGTH = 0.25     # 0..1, how far the text is pushed from the local image
MAX_PDF_PIXELS = 24_000_000  # cap on a rasterised PDF page's area, ~6000 × 4000


def get_args():
    p = argparse.ArgumentParser(description="Watermark an image or PDF with a text")
    p.add_argument("image_path", help="Image or PDF to watermark")
    p.add_argument("text", help="Text to watermark with")
    p.add_argument("--des", help="Save output (default watermarked.jpg, or .pdf for PDF input)")
    p.add_argument("--mode", choices=["seamless", "flat"], default="seamless",
                   help="seamless: Poisson-blend into the image texture (default); flat: plain alpha blend")
    p.add_argument("--dpi", type=int, default=150,
                   help="resolution for rasterising PDF pages (default 150)")
    p.add_argument("--size", type=float, default=SIZE,
                   help=f"text cap height as a fraction of the shorter image side (default {SIZE})")
    p.add_argument("--spacing", type=float, default=1.0,
                   help=f"multiplier on the gaps between copies, which by default are sized so the text "
                        f"covers about {COVERAGE:.1%} of the image (default 1.0)")
    p.add_argument("--strength", type=float, default=STRENGTH,
                   help=f"watermark strength / opacity, 0..1 (default {STRENGTH})")
    p.add_argument("--font", default=None,
                   help="TrueType/OpenType font file, needed for non-ASCII text such as Chinese (requires Pillow)")
    p.add_argument("--show", action="store_true", help="preview the result in a window before saving")
    return p.parse_args()


def _render_hershey(text, cap_h, thickness, margin):
    scale = cap_h / cv.getTextSize(text, FONT, 1.0, thickness)[0][1]
    (text_w, text_h), _ = cv.getTextSize(text, FONT, scale, thickness)
    under_y = margin + text_h + 2 * thickness
    core = np.zeros((under_y + thickness + margin, text_w + 2 * margin), np.uint8)
    cv.putText(core, text, (margin, margin + text_h), FONT, scale, 255, thickness, cv.LINE_AA)
    cv.line(core, (margin, under_y), (margin + text_w, under_y), 255, thickness, cv.LINE_AA)
    return core


def _render_truetype(text, cap_h, thickness, margin, font_path):
    from PIL import Image, ImageDraw, ImageFont
    probe = ImageFont.truetype(font_path, 100)
    l, t, r, b = probe.getbbox("H")
    font = ImageFont.truetype(font_path, max(1, round(100 * cap_h / (b - t))))
    l, t, r, b = font.getbbox(text, anchor="ls")
    under_y = 2 * thickness
    bottom = max(b, under_y + thickness)
    img = Image.new("L", (r - l + 2 * margin, bottom - t + 2 * margin), 0)
    org = (margin - l, margin - t)
    draw = ImageDraw.Draw(img)
    draw.text(org, text, fill=255, font=font, anchor="ls")
    draw.rectangle((margin, org[1] + under_y, margin + r - l, org[1] + under_y + thickness - 1), fill=255)
    return np.asarray(img)


def render_tile(text, cap_h, font_path=None) -> Tuple[np.ndarray, np.ndarray]:
    """Rasterise one underlined copy of the text.

    Returns (core, ring) as float32 in [0, 1]: core is the text, ring the outline
    around it. The tile is cropped to the ink plus a blank margin, so the blend
    region (the tile minus its 1px border) covers every stroke with room to spare.
    """
    thickness = max(1, round(cap_h / 12))
    halo = max(1, round(cap_h * HALO))
    margin = halo + thickness + 4
    if font_path:
        core = _render_truetype(text, cap_h, thickness, margin, font_path)
    else:
        if not text.isascii():
            raise ValueError("Hershey fonts are ASCII-only, pass --font for non-ASCII text")
        core = _render_hershey(text, cap_h, thickness, margin)
    # The outline is the text grown by halo px. Dilating, rather than drawing a
    # thicker stroke, works for any font: OpenCV 5's putText ignores thickness.
    disk = cv.getStructuringElement(cv.MORPH_ELLIPSE, (2 * halo + 1, 2 * halo + 1))
    outline = cv.dilate(core, disk).astype(np.float32) / 255
    core = core.astype(np.float32) / 255
    ring = np.maximum(outline - core, 0)

    ys, xs = np.nonzero(outline)
    pad = 3
    y0, x0 = ys.min() - pad, xs.min() - pad
    # Grow the tile so the solver's FFT length, 2 * (size - 1), factors into 2, 3, 5.
    h = _fft_friendly(ys.max() + pad + 1 - y0)
    w = _fft_friendly(xs.max() + pad + 1 - x0)
    core = np.pad(core, ((pad, h), (pad, w)))[y0 + pad:y0 + pad + h, x0 + pad:x0 + pad + w]
    ring = np.pad(ring, ((pad, h), (pad, w)))[y0 + pad:y0 + pad + h, x0 + pad:x0 + pad + w]
    return core, ring


def _fft_friendly(n):
    """Smallest m >= n such that m - 1 has no prime factor above 5."""
    m = n
    while True:
        r = m - 1
        for p in (2, 3, 5):
            while r % p == 0:
                r //= p
        if r == 1:
            return m
        m += 1


def tile_positions(image_shape, tile_shape, gap) -> List[Tuple[int, int]]:
    """Top-left corners of every tile that touches the image.

    Rows are staggered by half a cell and the pattern is centred on the image,
    so partial tiles at the edges are included. Gaps are kept wide enough that
    tiles never overlap, which lets every tile be blended independently.
    """
    image_h, image_w = image_shape[:2]
    tile_h, tile_w = tile_shape
    cell_w = tile_w + max(2, gap)
    cell_h = tile_h + max(2, gap)
    positions = []
    rows = image_h // (2 * cell_h) + 2
    cols = image_w // (2 * cell_w) + 2
    for j in range(-rows, rows + 1):
        cy = image_h / 2 + j * cell_h
        for i in range(-cols, cols + 1):
            cx = image_w / 2 + (i + 0.5 * (j % 2)) * cell_w
            x, y = round(cx - tile_w / 2), round(cy - tile_h / 2)
            if x + tile_w > 1 and y + tile_h > 1 and x < image_w - 1 and y < image_h - 1:
                positions.append((x, y))
    return positions


def _extract_windows(image, tile_shape, positions):
    """Copy each tile's window out of the image, plus the rectangle to blend in it.

    Window pixels outside the image are left at 0 and never blended. The blend
    rectangle is the window minus its 1px border, clipped so the image's own 1px
    border stays fixed; every blended pixel then has 4 in-image neighbours and
    the pixels around the rectangle are its (Dirichlet) boundary.
    """
    image_h, image_w = image.shape[:2]
    tile_h, tile_w = tile_shape
    windows = np.zeros((len(positions), tile_h, tile_w, image.shape[2]), np.float32)
    rects = []
    for k, (x, y) in enumerate(positions):
        x0, y0, x1, y1 = max(x, 0), max(y, 0), min(x + tile_w, image_w), min(y + tile_h, image_h)
        windows[k, y0 - y:y1 - y, x0 - x:x1 - x] = image[y0:y1, x0:x1]
        x0, y0 = max(x + 1, 1), max(y + 1, 1)
        x1, y1 = min(x + tile_w - 1, image_w - 1), min(y + tile_h - 1, image_h - 1)
        rects.append((y0 - y, y1 - y, x0 - x, x1 - x))
    return windows, rects


def _dst(a):
    """Type-I discrete sine transform over the last axis, via a real FFT.

    Applying it twice scales the input by (n + 1) / 2.
    """
    n = a.shape[-1]
    zero = np.zeros(a.shape[:-1] + (1,), a.dtype)
    odd = np.concatenate([zero, a, zero, -a[..., ::-1]], axis=-1)
    return -np.fft.rfft(odd, axis=-1).imag[..., 1:n + 1].astype(a.dtype) / 2


def _solve_poisson_rect(b):
    """Solve 4x - (sum of 4 neighbours) = b on rectangles, with x = 0 outside.

    b: (..., h, w). The 5-point Laplacian is diagonal in the DST-I basis, so this
    is an exact solve in O(hw log hw).
    """
    h, w = b.shape[-2:]
    lam_y = 2 - 2 * np.cos(np.pi * np.arange(1, h + 1) / (h + 1))
    lam_x = 2 - 2 * np.cos(np.pi * np.arange(1, w + 1) / (w + 1))
    t = _dst(_dst(b).swapaxes(-1, -2)).swapaxes(-1, -2)
    t /= (lam_y[:, None] + lam_x[None, :]).astype(b.dtype)
    x = _dst(_dst(t).swapaxes(-1, -2)).swapaxes(-1, -2)
    return x * np.float32(4 / ((h + 1) * (w + 1)))


def poisson_blend_mixed(dst, guide, rects):
    """Mixed-gradient Poisson blend of a guidance potential into image windows.

    dst: (n, h, w, c) float image windows, which also supply the boundary values.
    guide: (h, w) potential whose gradients carry the watermark, shared by every
    window, or (n, h, w) for one per window.
    rects: per window, the (y0, y1, x0, x1) rectangle to solve for; it must not
    touch the window border.

    For every pixel pair (p, q) the target difference f_p - f_q is the guide's
    difference if its magnitude beats the image's (summed over channels), else
    the image's. Returns the windows with each rectangle replaced by the solution.
    """
    channels = dst.shape[3]
    s = np.broadcast_to(guide, dst.shape[:3])[..., None]

    def mixed(sd, dd):
        return np.where(sd * sd * channels > np.sum(dd * dd, axis=3, keepdims=True), sd, dd)

    vx = mixed(s[:, :, :-1] - s[:, :, 1:], dst[:, :, :-1] - dst[:, :, 1:])
    vy = mixed(s[:, :-1] - s[:, 1:], dst[:, :-1] - dst[:, 1:])
    div = np.zeros_like(dst)
    div[:, :, :-1] += vx
    div[:, :, 1:] -= vx
    div[:, :-1] += vy
    div[:, 1:] -= vy

    out = dst.copy()
    groups = {}
    for k, (y0, y1, x0, x1) in enumerate(rects):
        if y1 > y0 and x1 > x0:
            groups.setdefault((y1 - y0, x1 - x0), []).append(k)
    for (h, w), ks in groups.items():
        b = np.empty((len(ks), h, w, channels), np.float32)
        for i, k in enumerate(ks):
            y0, y1, x0, x1 = rects[k]
            b[i] = div[k, y0:y1, x0:x1]
            # Known pixels just outside the rectangle move to the right-hand side.
            b[i, 0] += dst[k, y0 - 1, x0:x1]
            b[i, -1] += dst[k, y1, x0:x1]
            b[i, :, 0] += dst[k, y0:y1, x0 - 1]
            b[i, :, -1] += dst[k, y0:y1, x1]
        x = _solve_poisson_rect(b.transpose(0, 3, 1, 2)).transpose(0, 2, 3, 1)
        for i, k in enumerate(ks):
            y0, y1, x0, x1 = rects[k]
            out[k, y0:y1, x0:x1] = x[i]
    return out


def layout(image_shape, text, size=SIZE, spacing=1.0, font_path=None):
    """Render the tile at a size suited to the image and place its copies.

    The cap height is size * the shorter image side, reduced if one copy would
    be wider than MAX_WIDTH of the image, but never below half; very long text
    then runs past the edges rather than becoming unreadably small. The gap between copies (the same in
    both directions) is solved so the text ink covers COVERAGE of each grid cell,
    then scaled by spacing; this keeps density the same for short and long text.
    Returns (core, ring, positions).
    """
    image_h, image_w = image_shape[:2]
    cap_h = max(6, round(size * min(image_h, image_w)))
    core, ring = render_tile(text, cap_h, font_path)
    if core.shape[1] > MAX_WIDTH * image_w:
        cap_h = max(6, int(cap_h * max(0.5, MAX_WIDTH * image_w / core.shape[1])))
        core, ring = render_tile(text, cap_h, font_path)

    # (tile_w + gap) * (tile_h + gap) = ink / COVERAGE
    tile_h, tile_w = core.shape
    total = tile_w + tile_h
    gap = (np.sqrt(total ** 2 - 4 * (tile_w * tile_h - core.sum() / COVERAGE)) - total) / 2
    positions = tile_positions(image_shape, core.shape, round(gap * spacing))
    return core, ring, positions


def watermarkit_seamless_clone(image, text, size=SIZE, spacing=1.0, strength=STRENGTH, font_path=None):
    core, ring, positions = layout(image.shape, text, size, spacing, font_path)
    # Dark text with a light outline: the fill reads on light areas, the outline
    # on dark ones, and on busy texture the outline separates the glyph from it.
    guide = 255 * strength * (ring - core)

    windows, rects = _extract_windows(image, core.shape, positions)
    blended = poisson_blend_mixed(windows, guide, rects)

    canvas = image.copy()
    for (x, y), (y0, y1, x0, x1), win in zip(positions, rects, blended):
        if y1 > y0 and x1 > x0:
            canvas[y + y0:y + y1, x + x0:x + x1] = np.clip(win[y0:y1, x0:x1] + 0.5, 0, 255)
    return canvas


def watermarkit_put_text(image, text, size=SIZE, spacing=1.0, strength=STRENGTH, font_path=None,
                         color=(40, 40, 40), outline_color=(236, 236, 238)):
    """Flat alternative: alpha-blend dark text with a light outline, same layout."""
    core, ring, positions = layout(image.shape, text, size, spacing, font_path)
    alpha = min(1.0, 2 * strength)
    tile_h, tile_w = core.shape
    canvas = image.astype(np.float32)
    for x, y in positions:
        y0, y1 = max(y, 0), min(y + tile_h, image.shape[0])
        x0, x1 = max(x, 0), min(x + tile_w, image.shape[1])
        c = alpha * core[y0 - y:y1 - y, x0 - x:x1 - x, None]
        o = alpha * ring[y0 - y:y1 - y, x0 - x:x1 - x, None]
        roi = canvas[y0:y1, x0:x1]
        roi[:] = roi * (1 - c - o) + np.float32(color) * c + np.float32(outline_color) * o
    return np.clip(canvas + 0.5, 0, 255).astype(np.uint8)


def watermark_pdf_file(pdf_path, text, mode="seamless", size=SIZE, spacing=1.0,
                       strength=STRENGTH, font_path=None, dpi=150, des="watermarked.pdf", show=False):
    """Watermark every page of a PDF and save it as a new PDF.

    Each page is rasterised with pdfium, watermarked with the same pipeline as
    an image, and the pages are re-assembled into a PDF by Pillow. Page content
    becomes an image, so the original text is no longer selectable. If even the
    largest page would exceed MAX_PDF_PIXELS, the whole document is rasterised
    at a lower dpi: Pillow sizes every page from one shared resolution.
    """
    try:
        import pypdfium2 as pdfium
        from PIL import Image
    except ImportError:
        raise SystemExit("PDF support needs pypdfium2 and Pillow: pip install -r requirements.txt")

    watermark = watermarkit_seamless_clone if mode == "seamless" else watermarkit_put_text
    try:
        pdf = pdfium.PdfDocument(pdf_path)
    except pdfium.PdfiumError:
        raise SystemExit("Could not read this PDF (is it password-protected?)")
    try:
        # Filled-in form values are only drawn if the form is initialised.
        if pdf.get_formtype() is not None:
            pdf.init_forms()
        if len(pdf) == 0:
            raise SystemExit("PDF has no pages")
        scale = dpi / 72
        largest = max(w * h for w, h in (page.get_size() for page in pdf))
        if largest * scale ** 2 > MAX_PDF_PIXELS:
            scale = (MAX_PDF_PIXELS / largest) ** 0.5
            print(f"reduced rasterisation to {round(72 * scale)} dpi to bound memory")
        pages = []
        for page in pdf:
            # pdfium's native buffer is BGR, ready for OpenCV.
            image = page.render(scale=scale, may_draw_forms=True).to_numpy()[..., :3]
            watermarked = watermark(image, text, size=size, spacing=spacing,
                                    strength=strength, font_path=font_path)
            pages.append(Image.fromarray(cv.cvtColor(watermarked, cv.COLOR_BGR2RGB)))
            if show and len(pages) == 1:
                cv.imshow("Watermarked (page 1)", watermarked)
    finally:
        pdf.close()
    if show:
        cv.waitKey()
    pages[0].save(des, save_all=True, append_images=pages[1:], resolution=72 * scale, quality=92)
    return len(pages)


if __name__ == '__main__':
    args = get_args()
    if not args.font and not args.text.isascii():
        raise SystemExit("Hershey fonts are ASCII-only, pass --font for non-ASCII text")

    if args.image_path.lower().endswith(".pdf"):
        des = args.des or "watermarked.pdf"
        if not des.lower().endswith(".pdf"):
            des = os.path.splitext(des)[0] + ".pdf"
            print(f"note: PDF input produces PDF output; saving to {des}")
        n = watermark_pdf_file(args.image_path, args.text, mode=args.mode, size=args.size,
                               spacing=args.spacing, strength=args.strength, font_path=args.font,
                               dpi=args.dpi, des=des, show=args.show)
        print(f"saved {n} page{'s' if n != 1 else ''} to {des}")
    else:
        image = cv.imread(args.image_path)
        assert image is not None, "Image not found"
        watermark = watermarkit_seamless_clone if args.mode == "seamless" else watermarkit_put_text
        watermarked = watermark(image, args.text, size=args.size, spacing=args.spacing,
                                strength=args.strength, font_path=args.font)

        if args.show:
            cv.imshow("Watermarked", watermarked)
            cv.waitKey()
        des = args.des or "watermarked.jpg"
        cv.imwrite(des, watermarked)
        print(f"saved to {des}")
