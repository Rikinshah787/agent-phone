import zlib from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode 8-bit RGB pixels as PNG, using the "Sub" filter, which suits flat UI screenshots. */
export function encodePng(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1);
    const s = y * stride;
    raw[o] = 1;
    for (let i = 0; i < stride; i++) {
      raw[o + 1 + i] = (rgb[s + i] - (i >= 3 ? rgb[s + i - 3] : 0)) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Area-average downscale of RGBA/RGBX pixels to RGB. */
export function downscale(src: Uint8Array, w: number, h: number, ow: number, oh: number): Uint8Array {
  const out = new Uint8Array(ow * oh * 3);
  const xs = Array.from({ length: ow + 1 }, (_, i) => Math.floor((i * w) / ow));
  const ys = Array.from({ length: oh + 1 }, (_, i) => Math.floor((i * h) / oh));
  let o = 0;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = ys[oy];
    const y1 = Math.max(ys[oy + 1], y0 + 1);
    for (let ox = 0; ox < ow; ox++) {
      const x0 = xs[ox];
      const x1 = Math.max(xs[ox + 1], x0 + 1);
      let r = 0;
      let g = 0;
      let b = 0;
      for (let y = y0; y < y1; y++) {
        let p = (y * w + x0) * 4;
        for (let x = x0; x < x1; x++, p += 4) {
          r += src[p];
          g += src[p + 1];
          b += src[p + 2];
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      out[o++] = r / n;
      out[o++] = g / n;
      out[o++] = b / n;
    }
  }
  return out;
}
