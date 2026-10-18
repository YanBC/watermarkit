// Watermark layout and blending, a port of watermarkit.py. No DOM access, so it
// runs in the page, in a worker, and in Node for tests.
//
// Images are RGBA Uint8ClampedArray (canvas ImageData layout); only RGB is
// changed. A tile is {core, ring, w, h}: Float32Array masks in [0, 1] for the
// text and the outline around it.

export const SIZE = 0.035;      // cap height as a fraction of the image's shorter side
export const MAX_WIDTH = 0.8;   // shrink (to at most half size) if one copy is wider than this fraction of the image
export const COVERAGE = 0.045;  // gaps are chosen so text ink fills about this fraction of the image
export const HALO = 0.15;       // light outline width, in cap heights
export const STRENGTH = 0.25;   // 0..1, how far the text is pushed from the local image

const DARK = [40, 40, 40];
const LIGHT = [238, 236, 236];

// Python's round(): halves go to the nearest even integer. Used wherever the
// Python version rounds, so both produce the same layout.
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// Smallest m >= n such that m - 1 has no prime factor above 5.
function fftFriendly(n) {
  for (let m = n; ; m++) {
    let r = m - 1;
    for (const p of [2, 3, 5]) while (r % p === 0) r /= p;
    if (r === 1) return m;
  }
}

// Crop rendered masks to the ink plus a 3px margin, grown so the solver's FFT
// length, 2 * (size - 1), factors into 2, 3, 5.
export function cropTile(core, ring, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (core[y * w + x] > 0 || ring[y * w + x] > 0) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const pad = 3;
  x0 -= pad;
  y0 -= pad;
  const tw = fftFriendly(x1 + pad + 1 - x0);
  const th = fftFriendly(y1 + pad + 1 - y0);
  const c = new Float32Array(tw * th);
  const r = new Float32Array(tw * th);
  for (let y = 0; y < th; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < tw; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= w) continue;
      c[y * tw + x] = core[sy * w + sx];
      r[y * tw + x] = ring[sy * w + sx];
    }
  }
  return { core: c, ring: r, w: tw, h: th };
}

// Top-left corners of every tile that touches the image: a grid centred on the
// image, odd rows shifted by half a cell. Gaps of at least 2px keep tiles from
// overlapping, so each tile can be blended independently.
export function tilePositions(imgW, imgH, tileW, tileH, gap) {
  const cellW = tileW + Math.max(2, gap);
  const cellH = tileH + Math.max(2, gap);
  const rows = Math.floor(imgH / (2 * cellH)) + 2;
  const cols = Math.floor(imgW / (2 * cellW)) + 2;
  const positions = [];
  for (let j = -rows; j <= rows; j++) {
    const cy = imgH / 2 + j * cellH;
    const odd = ((j % 2) + 2) % 2;
    for (let i = -cols; i <= cols; i++) {
      const cx = imgW / 2 + (i + 0.5 * odd) * cellW;
      const x = pyRound(cx - tileW / 2);
      const y = pyRound(cy - tileH / 2);
      if (x + tileW > 1 && y + tileH > 1 && x < imgW - 1 && y < imgH - 1) positions.push([x, y]);
    }
  }
  return positions;
}

// Pick the text size and place the copies. renderTile(capH) must return a
// cropped tile (see cropTile). Returns {tile, positions, capH}.
export function layout(imgW, imgH, renderTile, { size = SIZE, spacing = 1 } = {}) {
  let capH = Math.max(6, pyRound(size * Math.min(imgW, imgH)));
  let tile = renderTile(capH);
  if (tile.w > MAX_WIDTH * imgW) {
    capH = Math.max(6, Math.floor(capH * Math.max(0.5, (MAX_WIDTH * imgW) / tile.w)));
    tile = renderTile(capH);
  }
  // (tile.w + gap) * (tile.h + gap) = ink / COVERAGE
  let ink = 0;
  for (let i = 0; i < tile.core.length; i++) ink += tile.core[i];
  const total = tile.w + tile.h;
  const gap = (Math.sqrt(total * total - 4 * (tile.w * tile.h - ink / COVERAGE)) - total) / 2;
  return { tile, positions: tilePositions(imgW, imgH, tile.w, tile.h, pyRound(gap * spacing)), capH };
}

// ---------------------------------------------------------------------------
// FFT: mixed radix (2, 3, 4, 5) for smooth lengths, Bluestein for the rest.

const plans = new Map();

function getPlan(n) {
  let plan = plans.get(n);
  if (plan) return plan;
  const factors = [];
  let r = n;
  for (const p of [4, 2, 3, 5]) {
    while (r % p === 0) {
      factors.push(p);
      r /= p;
    }
  }
  if (r === 1) {
    const cos = new Float64Array(n);
    const sin = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      cos[k] = Math.cos((2 * Math.PI * k) / n);
      sin[k] = Math.sin((2 * Math.PI * k) / n);
    }
    // Input index i = r0 + p0 * (r1 + p1 * (...)) lands at r0 * n/p0 + r1 * n/(p0 p1) + ...
    const perm = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      let rest = i, pos = 0, block = n;
      for (const p of factors) {
        block /= p;
        pos += (rest % p) * block;
        rest = Math.floor(rest / p);
      }
      perm[pos] = i;
    }
    plan = { n, factors, cos, sin, perm, re: new Float64Array(n), im: new Float64Array(n) };
  } else {
    let m = 1;
    while (m < 2 * n - 1) m *= 2;
    const inner = getPlan(m);
    const wr = new Float64Array(n);
    const wi = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * ((k * k) % (2 * n))) / n;
      wr[k] = Math.cos(a);
      wi[k] = -Math.sin(a);
    }
    const br = new Float64Array(m);
    const bi = new Float64Array(m);
    for (let k = 0; k < n; k++) {
      br[k] = wr[k];
      bi[k] = -wi[k];
      if (k > 0) {
        br[m - k] = wr[k];
        bi[m - k] = -wi[k];
      }
    }
    fftInPlace(inner, br, bi);
    plan = { n, m, inner, wr, wi, br, bi, ar: new Float64Array(m), ai: new Float64Array(m) };
  }
  plans.set(n, plan);
  return plan;
}

// Forward DFT of (re, im) in place: X_k = sum_j x_j exp(-2 pi i jk / n).
function fftInPlace(plan, re, im) {
  if (plan.inner) return bluestein(plan, re, im);
  const { n, factors, cos, sin, perm } = plan;
  const ar = plan.re, ai = plan.im;
  for (let i = 0; i < n; i++) {
    ar[i] = re[perm[i]];
    ai[i] = im[perm[i]];
  }
  const tr = new Float64Array(5), ti = new Float64Array(5);
  let s = 1;
  for (let f = factors.length - 1; f >= 0; f--) {
    const p = factors[f];
    const L = s * p;
    const tstep = n / L;
    const pstep = n / p;
    for (let b = 0; b < n; b += L) {
      for (let j = 0; j < s; j++) {
        for (let q = 0; q < p; q++) {
          const idx = b + q * s + j;
          const t = (q * j * tstep) % n;
          const c = cos[t], sn = sin[t];
          tr[q] = ar[idx] * c + ai[idx] * sn;
          ti[q] = ai[idx] * c - ar[idx] * sn;
        }
        if (p === 2) {
          ar[b + j] = tr[0] + tr[1];
          ai[b + j] = ti[0] + ti[1];
          ar[b + s + j] = tr[0] - tr[1];
          ai[b + s + j] = ti[0] - ti[1];
        } else if (p === 4) {
          const s0r = tr[0] + tr[2], s0i = ti[0] + ti[2];
          const d0r = tr[0] - tr[2], d0i = ti[0] - ti[2];
          const s1r = tr[1] + tr[3], s1i = ti[1] + ti[3];
          const d1r = tr[1] - tr[3], d1i = ti[1] - ti[3];
          ar[b + j] = s0r + s1r;
          ai[b + j] = s0i + s1i;
          ar[b + s + j] = d0r + d1i;
          ai[b + s + j] = d0i - d1r;
          ar[b + 2 * s + j] = s0r - s1r;
          ai[b + 2 * s + j] = s0i - s1i;
          ar[b + 3 * s + j] = d0r - d1i;
          ai[b + 3 * s + j] = d0i + d1r;
        } else {
          for (let q2 = 0; q2 < p; q2++) {
            let sr = 0, si = 0;
            for (let q = 0; q < p; q++) {
              const t = ((q * q2) % p) * pstep;
              sr += tr[q] * cos[t] + ti[q] * sin[t];
              si += ti[q] * cos[t] - tr[q] * sin[t];
            }
            ar[b + q2 * s + j] = sr;
            ai[b + q2 * s + j] = si;
          }
        }
      }
    }
    s = L;
  }
  re.set(ar);
  im.set(ai);
}

function bluestein(plan, re, im) {
  const { n, m, inner, wr, wi, br, bi, ar, ai } = plan;
  ar.fill(0);
  ai.fill(0);
  for (let k = 0; k < n; k++) {
    ar[k] = re[k] * wr[k] - im[k] * wi[k];
    ai[k] = re[k] * wi[k] + im[k] * wr[k];
  }
  fftInPlace(inner, ar, ai);
  // Multiply by FFT(b), then inverse FFT as conj(FFT(conj(x))) / m.
  for (let k = 0; k < m; k++) {
    const r = ar[k] * br[k] - ai[k] * bi[k];
    const i = ar[k] * bi[k] + ai[k] * br[k];
    ar[k] = r;
    ai[k] = -i;
  }
  fftInPlace(inner, ar, ai);
  for (let k = 0; k < n; k++) {
    const r = ar[k] / m, i = -ai[k] / m;
    re[k] = r * wr[k] - i * wi[k];
    im[k] = r * wi[k] + i * wr[k];
  }
}

// Type-I DST over each of `rows` rows of length n in data, in place
// (unnormalised; applying it twice scales by (n + 1) / 2). Two rows share one
// complex FFT of the odd extension: real part carries row a, imaginary row b.
function dstRows(data, rows, n) {
  const M = 2 * (n + 1);
  const plan = getPlan(M);
  const re = new Float64Array(M), im = new Float64Array(M);
  for (let r = 0; r < rows; r += 2) {
    const a = r * n;
    const b = r + 1 < rows ? (r + 1) * n : -1;
    re.fill(0);
    im.fill(0);
    for (let k = 0; k < n; k++) {
      re[k + 1] = data[a + k];
      re[M - 1 - k] = -data[a + k];
      if (b >= 0) {
        im[k + 1] = data[b + k];
        im[M - 1 - k] = -data[b + k];
      }
    }
    fftInPlace(plan, re, im);
    for (let k = 0; k < n; k++) {
      data[a + k] = -im[k + 1] / 2;
      if (b >= 0) data[b + k] = re[k + 1] / 2;
    }
  }
}

function transpose(src, h, w, dst) {
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) dst[x * h + y] = src[y * w + x];
}

// Solve 4x - (sum of 4 neighbours) = b on an h x w rectangle with x = 0
// outside, exactly: the 5-point Laplacian is diagonal in the DST-I basis.
// b is overwritten with x.
export function solvePoissonRect(b, h, w) {
  const t = new Float64Array(h * w);
  dstRows(b, h, w);
  transpose(b, h, w, t);
  dstRows(t, w, h);
  for (let x = 0; x < w; x++) {
    const lx = 2 - 2 * Math.cos((Math.PI * (x + 1)) / (w + 1));
    for (let y = 0; y < h; y++) {
      t[x * h + y] /= 2 - 2 * Math.cos((Math.PI * (y + 1)) / (h + 1)) + lx;
    }
  }
  dstRows(t, w, h);
  transpose(t, w, h, b);
  dstRows(b, h, w);
  const scale = 4 / ((h + 1) * (w + 1));
  for (let i = 0; i < b.length; i++) b[i] *= scale;
  return b;
}

// ---------------------------------------------------------------------------

// Mixed-gradient Poisson blend of the tile into every position, in place.
// Guide potential: dark text with a light outline. Per tile, the rectangle is
// the tile minus its 1px border, clipped so the image's own border stays fixed;
// the pixels around it are the (Dirichlet) boundary. For every pixel pair the
// target difference is the guide's if its magnitude beats the image's (summed
// over RGB), else the image's.
export function blendSeamless(rgba, imgW, imgH, tile, positions, strength = STRENGTH) {
  const { w: tw, h: th } = tile;
  const guide = new Float64Array(tw * th);
  for (let i = 0; i < guide.length; i++) {
    guide[i] = Math.fround(255 * strength * Math.fround(tile.ring[i] - tile.core[i]));
  }
  const win = new Float64Array(tw * th * 3);
  const NB = [[0, 1], [0, -1], [1, 0], [-1, 0]];
  for (const [x, y] of positions) {
    const x0 = Math.max(x + 1, 1) - x, y0 = Math.max(y + 1, 1) - y;
    const x1 = Math.min(x + tw - 1, imgW - 1) - x, y1 = Math.min(y + th - 1, imgH - 1) - y;
    const rw = x1 - x0, rh = y1 - y0;
    if (rw <= 0 || rh <= 0) continue;

    // The rectangle plus its 1px ring is always inside the image.
    for (let wy = y0 - 1; wy <= y1; wy++) {
      for (let wx = x0 - 1; wx <= x1; wx++) {
        const s = ((y + wy) * imgW + x + wx) * 4, d = (wy * tw + wx) * 3;
        win[d] = rgba[s];
        win[d + 1] = rgba[s + 1];
        win[d + 2] = rgba[s + 2];
      }
    }

    const planes = [new Float64Array(rw * rh), new Float64Array(rw * rh), new Float64Array(rw * rh)];
    for (let ry = 0; ry < rh; ry++) {
      for (let rx = 0; rx < rw; rx++) {
        const wy = ry + y0, wx = rx + x0;
        const p = wy * tw + wx;
        let b0 = 0, b1 = 0, b2 = 0;
        for (const [dy, dx] of NB) {
          const qy = wy + dy, qx = wx + dx;
          const q = qy * tw + qx;
          const sd = guide[p] - guide[q];
          const d0 = win[p * 3] - win[q * 3];
          const d1 = win[p * 3 + 1] - win[q * 3 + 1];
          const d2 = win[p * 3 + 2] - win[q * 3 + 2];
          if (sd * sd * 3 > d0 * d0 + d1 * d1 + d2 * d2) {
            b0 += sd;
            b1 += sd;
            b2 += sd;
          } else {
            b0 += d0;
            b1 += d1;
            b2 += d2;
          }
          if (qy < y0 || qy >= y1 || qx < x0 || qx >= x1) {
            b0 += win[q * 3];
            b1 += win[q * 3 + 1];
            b2 += win[q * 3 + 2];
          }
        }
        const i = ry * rw + rx;
        planes[0][i] = b0;
        planes[1][i] = b1;
        planes[2][i] = b2;
      }
    }

    for (let c = 0; c < 3; c++) {
      const sol = solvePoissonRect(planes[c], rh, rw);
      for (let ry = 0; ry < rh; ry++) {
        const row = ((y + y0 + ry) * imgW + x + x0) * 4 + c;
        for (let rx = 0; rx < rw; rx++) {
          const v = Math.floor(sol[ry * rw + rx] + 0.5);
          rgba[row + rx * 4] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return rgba;
}

// Flat alternative: alpha-blend dark text with a light outline, in place.
export function blendFlat(rgba, imgW, imgH, tile, positions, strength = STRENGTH) {
  const { w: tw, h: th } = tile;
  const alpha = Math.min(1, 2 * strength);
  for (const [x, y] of positions) {
    const ys = Math.max(y, 0), ye = Math.min(y + th, imgH);
    const xs = Math.max(x, 0), xe = Math.min(x + tw, imgW);
    for (let py = ys; py < ye; py++) {
      for (let px = xs; px < xe; px++) {
        const t = (py - y) * tw + (px - x);
        const c = alpha * tile.core[t], o = alpha * tile.ring[t];
        if (c === 0 && o === 0) continue;
        const s = (py * imgW + px) * 4;
        for (let k = 0; k < 3; k++) {
          const v = Math.floor(rgba[s + k] * (1 - c - o) + DARK[k] * c + LIGHT[k] * o + 0.5);
          rgba[s + k] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
      }
    }
  }
  return rgba;
}
