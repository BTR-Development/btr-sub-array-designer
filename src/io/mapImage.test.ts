import { describe, expect, it } from 'vitest';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { withPngText } from './mapImage';

/** A real 1×1 PNG, so the test walks the chunks a decoder would. */
const ONE_PIXEL = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQUDD4DwACBAFgjby7cQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

function chunks(png: Uint8Array): Array<{ type: string; data: Uint8Array; crcOk: boolean }> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out = [];
  for (let at = 8; at < png.length; ) {
    const len = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + len);
    const crc = view.getUint32(at + 8 + len);
    out.push({ type, data, crcOk: zlibCrc32(png.subarray(at + 4, at + 8 + len)) === crc });
    at += 12 + len;
  }
  return out;
}

describe('withPngText', () => {
  it('puts UTF-8 text chunks straight after IHDR, with valid CRCs, and leaves the image alone', () => {
    const out = withPngText(ONE_PIXEL, { Title: 'Zażółć gęślą jaźń — 63 Hz', 'btr:simulation': '{"frequencyHz":63}' });
    const list = chunks(out);
    expect(list.map((c) => c.type)).toEqual(['IHDR', 'iTXt', 'iTXt', 'IDAT', 'IEND']);
    expect(list.every((c) => c.crcOk)).toBe(true);
    const text = new TextDecoder().decode(list[1].data);
    // keyword \0 flag method language\0 translated\0 text
    expect(text).toBe('Title\0\0\0\0\0Zażółć gęślą jaźń — 63 Hz');
    expect(new TextDecoder().decode(list[2].data).endsWith('{"frequencyHz":63}')).toBe(true);
    // the original chunks byte for byte
    const orig = chunks(ONE_PIXEL);
    expect(list[3].data).toEqual(orig[1].data);
  });
});
