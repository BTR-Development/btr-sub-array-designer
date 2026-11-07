/**
 * Pack the macOS iconset PNGs (from desktop/make-icon.mjs) into a Windows .ico.
 * ICO entries may carry PNG data as-is (Vista and later), so this is a header
 * and a directory in front of the files — no image library needed.
 *
 *   node desktop/windows/make-ico.mjs <iconset-dir> <out.ico>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , dir, out] = process.argv;
const sizes = [16, 24, 32, 48, 64, 128, 256];
const pick = (s) => {
  for (const name of [`icon_${s}x${s}.png`, `icon_${s / 2}x${s / 2}@2x.png`]) {
    try {
      return readFileSync(join(dir, name));
    } catch {
      /* next */
    }
  }
  return null;
};
const images = sizes.map((s) => ({ s, png: pick(s) })).filter((x) => x.png);
if (!images.length) throw new Error(`no icon PNGs in ${dir}`);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(images.length, 4);
const entries = [];
let offset = 6 + 16 * images.length;
for (const { s, png } of images) {
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0);
  e.writeUInt8(s >= 256 ? 0 : s, 1);
  e.writeUInt8(0, 2);
  e.writeUInt8(0, 3);
  e.writeUInt16LE(1, 4);
  e.writeUInt16LE(32, 6);
  e.writeUInt32LE(png.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(e);
}
writeFileSync(out, Buffer.concat([header, ...entries, ...images.map((x) => x.png)]));
console.log(`${out}: ${images.map((x) => x.s).join(', ')} px`);
