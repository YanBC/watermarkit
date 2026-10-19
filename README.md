Tile a text watermark across an image or a PDF. The default mode blends the text into the image with mixed-gradient Poisson blending, so the watermark picks up the local texture.

```bash
pip install -r requirements.txt
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY" --des out.jpg
python watermarkit.py imgs/rem.jpg "僅供核實 SAMPLE" --font /path/to/cjk-font.ttc   # non-ASCII needs --font (and Pillow)
python watermarkit.py document.pdf "FOR VERIFICATION ONLY"                        # writes watermarked.pdf
```

Text size and spacing adapt to the image and the text length. Options: `--size` (cap height as a fraction of the shorter image side), `--spacing` (multiplier on the automatic gaps), `--strength` (0..1, default 0.25), `--mode seamless|flat`, `--font`, `--show` (preview window), `--dpi` (PDF only, default 150).

PDF pages are rasterised with pdfium, watermarked with the same pipeline as an image, and re-assembled into a PDF — the original page text stops being selectable. If a page is huge, the whole document is rasterised at a lower dpi so memory stays bounded; physical page sizes are kept.

## Web app

`web/` is the same watermark as a static page that runs entirely in the browser (images and PDFs are never uploaded). It accepts images and PDFs; PDF pages are rendered with the vendored pdf.js (`web/vendor/`, Apache-2.0 — also carries `standard_fonts/` and `cmaps/` for PDFs that don't embed their fonts) and the download is assembled with the vendored pdf-lib. Try it locally with `python3 -m http.server -d web 8000` and open http://localhost:8000.

The PDF preview shows the first page only; the settings apply to every page when downloading. Pages are rasterised at 150 dpi, so like the CLI the original text stops being selectable.

To deploy on Vercel: import the repository, set **Root Directory** to `web`, framework preset **Other**, no build command.

## Tests

```bash
python3 tests/parity.py                   # JS blend vs Python on the sample images (needs Node 18+)
python3 tests/pdf_smoke.py                # CLI PDF path end to end (needs pypdfium2 + Pillow)
```

## TODO
1. <del>opencv poisson blending</del>
2. <del>web UI</del>
3. <del>PDF support</del>
4. docker runtime env
5. <del>Chinese font</del> (via `--font`)
6. GPU for faster poisson blending
7. OCR to avoid mixture of texts
