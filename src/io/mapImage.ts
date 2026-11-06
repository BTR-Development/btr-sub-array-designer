/**
 * The map as a picture.
 *
 * Until now the only way to show a client or a production manager the map was
 * a screenshot, and a screenshot carries neither the colour scale nor what the
 * map was calculated from, so a band-averaged map and a single-tone map of the
 * same rig were indistinguishable a week later. The picture is the plot as it
 * is drawn on screen — the same pixels, at the screen's own resolution — with
 * a heading above it (frequency or band, dB window, data grade) and the colour
 * scale beside it, and the same facts written into the PNG's text chunks so a
 * file that has lost its caption still says what it is.
 *
 * Levels stay relative: the scale reads dB below the loudest point, as on
 * screen. No absolute SPL is added on the way out.
 */
import { colorForFraction, legendTicks, type PaletteId } from '../render/colormap';

export interface MapImageSpec {
  /** the plot canvas as it is on screen */
  canvas: HTMLCanvasElement;
  /** heading lines, first one bold */
  lines: string[];
  palette: PaletteId;
  dynamicRangeDb: number;
  /** dB per contour band, 0 = continuous; the bar is banded like the map */
  dbPerDivision: number;
  /** written into the PNG as tEXt chunks */
  metadata: Record<string, string>;
  background: string;
  foreground: string;
  dim: string;
  font: string;
}

const HEAD = 58;
const LEGEND = 78;
const PAD = 12;

/** Composes the picture; returns the canvas so a test can read it back. */
export function composeMapImage(spec: MapImageSpec): HTMLCanvasElement {
  const src = spec.canvas;
  // device pixels per CSS pixel of the plot, so the picture is as sharp as the screen
  const k = src.clientWidth > 0 ? src.width / src.clientWidth : 1;
  const out = document.createElement('canvas');
  out.width = src.width + Math.round(LEGEND * k);
  out.height = src.height + Math.round(HEAD * k);
  const g = out.getContext('2d');
  if (!g) throw new Error('no 2D context for the map image');

  g.fillStyle = spec.background;
  g.fillRect(0, 0, out.width, out.height);
  g.drawImage(src, 0, Math.round(HEAD * k));

  g.textBaseline = 'top';
  spec.lines.forEach((line, i) => {
    g.fillStyle = i === 0 ? spec.foreground : spec.dim;
    g.font = `${i === 0 ? 600 : 400} ${Math.round((i === 0 ? 13 : 11) * k)}px ${spec.font}`;
    g.fillText(line, PAD * k, (8 + i * 16) * k, out.width - 2 * PAD * k);
  });

  // the colour scale, the same mapping colorize() and the on-screen bar use
  const range = Math.max(1e-6, spec.dynamicRangeDb);
  const bands = spec.dbPerDivision > 0 ? Math.round(range / spec.dbPerDivision) : 0;
  const x = src.width + 14 * k;
  const top = (HEAD + 16) * k;
  const h = Math.min(src.height - 32 * k, 320 * k);
  const w = 16 * k;
  const steps = Math.max(2, Math.round(h));
  for (let i = 0; i < steps; i++) {
    g.fillStyle = colorForFraction(spec.palette, 1 - (i + 0.5) / steps, bands);
    g.fillRect(x, top + (i * h) / steps, w, h / steps + 1);
  }
  g.strokeStyle = spec.dim;
  g.lineWidth = Math.max(1, k);
  g.strokeRect(x, top, w, h);
  g.fillStyle = spec.foreground;
  g.font = `${Math.round(10 * k)}px ${spec.font}`;
  g.textBaseline = 'middle';
  for (const db of legendTicks(spec.dynamicRangeDb)) {
    const y = top + (-db / range) * h;
    g.fillRect(x + w, y, 4 * k, Math.max(1, k));
    g.fillText(db === 0 ? '0 dB' : String(db), x + w + 7 * k, y);
  }
  return out;
}

// ── PNG text chunks ────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * An iTXt chunk (UTF-8, uncompressed): tEXt is Latin-1 only, and a project
 * name or a note in Polish would not survive it.
 */
function itxtChunk(keyword: string, text: string): Uint8Array {
  const enc = new TextEncoder();
  const key = enc.encode(keyword);
  const body = enc.encode(text);
  // keyword \0 compression-flag compression-method language \0 translated \0 text
  const data = new Uint8Array(key.length + 5 + body.length);
  data.set(key, 0);
  data.set(body, key.length + 5);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(enc.encode('iTXt'), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Inserts text chunks right after IHDR, where every reader looks for them. */
export function withPngText(png: Uint8Array, entries: Record<string, string>): Uint8Array {
  const SIG = 8;
  const ihdrLen = new DataView(png.buffer, png.byteOffset).getUint32(SIG);
  const afterIhdr = SIG + 12 + ihdrLen;
  const chunks = Object.entries(entries).map(([k, v]) => itxtChunk(k, v));
  const extra = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, afterIhdr), 0);
  let at = afterIhdr;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  out.set(png.subarray(afterIhdr), at);
  return out;
}

export async function mapImagePng(spec: MapImageSpec): Promise<Blob> {
  const canvas = composeMapImage(spec);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('the browser could not encode the map image');
  const bytes = withPngText(new Uint8Array(await blob.arrayBuffer()), spec.metadata);
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}
