Tile a text watermark across an image. The default mode blends the text into the image with mixed-gradient Poisson blending, so the watermark picks up the local texture.

```bash
pip install -r requirements.txt
python watermarkit.py imgs/demo_id.jpg "FOR VERIFICATION ONLY" --des out.jpg
python watermarkit.py imgs/rem.jpg "僅供核實 SAMPLE" --font /path/to/cjk-font.ttc   # non-ASCII needs --font (and Pillow)
```

Options: `--size` (cap height as a fraction of the shorter image side), `--spacing` (gap multiplier), `--strength` (0..1), `--mode seamless|flat`, `--font`, `--show` (preview window).

## TODO
1. <del>opencv poisson blending</del>
2. web UI
3. docker runtime env
4. <del>Chinese font</del> (via `--font`)
5. GPU for faster poisson blending
6. OCR to avoid mixture of texts
