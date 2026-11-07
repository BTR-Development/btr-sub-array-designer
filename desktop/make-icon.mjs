/**
 * Build the app icon from the house mark.
 *
 * The logo artwork is white on transparent, which would be invisible in the Dock,
 * so it is composited onto the app's own chrome colour with the rounded-rectangle
 * mask macOS icons use. No dependencies — same hand-rolled PNG path as the rest
 * of the tooling here, because adding an image library to draw one square would
 * be silly.
 *
 *   node desktop/make-icon.mjs <logo.png> <out-dir>
 *
 * Writes AppIcon.iconset/ and leaves iconutil to produce the .icns.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const [, , logoPath, outDir] = process.argv;
mkdirSync(outDir, { recursive: true });

// ── decode the logo (8-bit RGBA) ──────────────────────────────────────────
const buf = readFileSync(logoPath);
let pos = 8;
let ihdr = null;
const idat = [];
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos);
  const type = buf.toString('ascii', pos + 4, pos + 8);
  const data = buf.subarray(pos + 8, pos + 8 + len);
  if (type === 'IHDR') ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], color: data[9] };
  else if (type === 'IDAT') idat.push(data);
  else if (type === 'IEND') break;
  pos += 12 + len;
}
if (ihdr.depth !== 8 || ihdr.color !== 6) throw new Error('expected 8-bit RGBA logo');

const { w: LW, h: LH } = ihdr;
const raw = inflateSync(Buffer.concat(idat));
const lstride = LW * 4;
const logo = Buffer.alloc(LH * lstride);
for (let y = 0; y < LH; y++) {
  const f = raw[y * (lstride + 1)];
  const src = raw.subarray(y * (lstride + 1) + 1, (y + 1) * (lstride + 1));
  const cur = logo.subarray(y * lstride, (y + 1) * lstride);
  const prev = y ? logo.subarray((y - 1) * lstride, y * lstride) : null;
  for (let x = 0; x < lstride; x++) {
    const a = x >= 4 ? cur[x - 4] : 0, b = prev ? prev[x] : 0, c = prev && x >= 4 ? prev[x - 4] : 0;
    let v = src[x];
    if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    cur[x] = v & 255;
  }
}

// ── PNG writer ────────────────────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => {
  const l = Buffer.alloc(4); l.writeUInt32BE(d.length);
  const body = Buffer.concat([Buffer.from(t, 'ascii'), d]);
  const cc = Buffer.alloc(4); cc.writeUInt32BE(crc32(body));
  return Buffer.concat([l, body, cc]);
};
function writePng(path, px, w, h) {
  const stride = w * 4;
  const rows = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    rows[y * (stride + 1)] = 0;
    px.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  writeFileSync(path, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ih), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ── compose one icon size ─────────────────────────────────────────────────
const BG = [0x14, 0x19, 0x22];   // the app's panel ground
const EDGE = [0x38, 0xc7, 0xc7]; // the teal accent, as a hairline

/** Coverage of a rounded rect at a pixel centre, sampled 3x3 for a soft edge. */
function roundedCoverage(x, y, size, radius, inset) {
  const lo = inset, hi = size - inset;
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const px = x + (sx + 0.5) / 3, py = y + (sy + 0.5) / 3;
      if (px < lo || px > hi || py < lo || py > hi) continue;
      const cx = Math.min(Math.max(px, lo + radius), hi - radius);
      const cy = Math.min(Math.max(py, lo + radius), hi - radius);
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 9;
}

function render(size) {
  const out = Buffer.alloc(size * size * 4);
  const inset = size * 0.055;
  const radius = size * 0.2237; // the macOS squircle, near enough at icon sizes

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cov = roundedCoverage(x, y, size, radius, inset);
      const o = (y * size + x) * 4;
      out[o] = BG[0]; out[o + 1] = BG[1]; out[o + 2] = BG[2];
      out[o + 3] = Math.round(cov * 255);
    }
  }

  // logo, box-fitted into the middle with generous margins
  const targetW = Math.round(size * 0.60);
  const scale = targetW / LW;
  const targetH = Math.max(1, Math.round(LH * scale));
  const ox = Math.round((size - targetW) / 2);
  const oy = Math.round((size - targetH) / 2);

  for (let ty = 0; ty < targetH; ty++) {
    const sy0 = Math.floor((ty * LH) / targetH), sy1 = Math.max(Math.floor(((ty + 1) * LH) / targetH), sy0 + 1);
    for (let tx = 0; tx < targetW; tx++) {
      const sx0 = Math.floor((tx * LW) / targetW), sx1 = Math.max(Math.floor(((tx + 1) * LW) / targetW), sx0 + 1);
      let a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) { a += logo[sy * lstride + sx * 4 + 3]; n++; }
      }
      const alpha = a / n / 255;
      if (alpha <= 0) continue;
      const px = ox + tx, py = oy + ty;
      if (px < 0 || py < 0 || px >= size || py >= size) continue;
      const o = (py * size + px) * 4;
      // the mark is white; blend it over whatever the plate already has
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(out[o + k] * (1 - alpha) + 255 * alpha);
      out[o + 3] = Math.max(out[o + 3], Math.round(alpha * 255));
    }
  }

  // a one-pixel teal rim, so the plate reads as an instrument face
  if (size >= 64) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = roundedCoverage(x, y, size, radius, inset);
        const inner = roundedCoverage(x, y, size, radius - size * 0.008, inset + size * 0.008);
        const rim = Math.max(0, c - inner);
        if (rim <= 0.02) continue;
        const o = (y * size + x) * 4;
        for (let k = 0; k < 3; k++) out[o + k] = Math.round(out[o + k] * (1 - rim * 0.55) + EDGE[k] * rim * 0.55);
      }
    }
  }

  return out;
}

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
for (const s of SIZES) {
  const px = render(s);
  writePng(`${outDir}/icon_${s}x${s}.png`, px, s, s);
  if (s >= 32) writePng(`${outDir}/icon_${s / 2}x${s / 2}@2x.png`, px, s, s);
}
console.log(`icon set written to ${outDir}`);
