Tile a text watermark across an image. The default mode blends the text into the image with mixed-gradient Poisson blending, so the watermark picks up the local texture.

```bash
pip install -r requirements.txt
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY" --des out.jpg
python watermarkit.py imgs/rem.jpg "僅供核實 SAMPLE" --font /path/to/cjk-font.ttc   # non-ASCII needs --font (and Pillow)
```

Text size and spacing adapt to the image and the text length. Options: `--size` (cap height as a fraction of the shorter image side), `--spacing` (multiplier on the automatic gaps), `--strength` (0..1, default 0.25), `--mode seamless|flat`, `--font`, `--show` (preview window).

## Web app

`web/` is the same watermark as a static page that runs entirely in the browser (images are never uploaded). Try it locally with `python3 -m http.server -d web 8000` and open http://localhost:8000.

To deploy on Vercel: import the repository, set **Root Directory** to `web`, framework preset **Other**, no build command.

## TODO
1. <del>opencv poisson blending</del>
2. <del>web UI</del>
3. docker runtime env
4. <del>Chinese font</del> (via `--font`)
5. GPU for faster poisson blending
6. OCR to avoid mixture of texts
