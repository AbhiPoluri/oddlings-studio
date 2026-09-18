import { zlibSync } from 'fflate';
import { type ColorAtlas } from './asset-uv';

/**
 * A minimal PNG writer for the baked colour atlas.
 *
 * Hand-rolled because the alternatives are all worse here. A canvas does not
 * exist in Node, `node:zlib` does not exist in the browser or the worker, and a
 * PNG encoder is a dependency to carry for what is a zlib stream with four
 * chunks wrapped around it. fflate is already in the bundle for the Unity zip
 * and its `zlibSync` emits exactly the RFC 1950 stream an IDAT chunk holds, so
 * the studio download and the CLI can share one encoder and produce the same
 * file rather than the CLI shipping a texture the browser silently drops.
 */

/** Reversed-polynomial CRC-32 table, built once. PNG checksums every chunk. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let bit = 0; bit < 8; bit++)
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** One chunk: length, four-character type, payload, CRC of type and payload. */
function chunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

/**
 * Encode a baked atlas as an 8-bit RGBA PNG.
 *
 * Every row uses filter 0. The atlas is flat colour in large blocks, which
 * deflate already collapses to a couple of hundred kilobytes, so the per-row
 * predictors would buy bytes nobody is counting and cost a pass over four
 * megabytes to do it.
 */
export function encodePng(atlas: ColorAtlas) {
  const { width, height, rgba } = atlas;
  const stride = width * 4;
  // PNG prefixes each scanline with its filter byte, so the raw stream is one
  // byte wider per row than the image itself.
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bits per channel
  header[9] = 6; // colour type: truecolour with alpha

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}
