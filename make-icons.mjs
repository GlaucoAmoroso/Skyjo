// make-icons.mjs — generates the PNG icons (192, 512, 180 for iOS) with no dependencies.
// Usage: node make-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

// distanza con segno da un rettangolo arrotondato (negativa = dentro)
const sdRound = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - (hw - r), qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d)); // copertura anti-alias a 1px

function png(size) {
  const s = size / 512;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let rgb = [246, 241, 231]; // ivory
      const mix = (c, a) => { rgb = rgb.map((v, i) => v * (1 - a) + c[i] * a); };
      mix([228, 217, 195], cover(sdRound(x, y, 256 * s, 256 * s, 111 * s, 161 * s, 35 * s)));
      mix([255, 253, 248], cover(sdRound(x, y, 256 * s, 256 * s, 109 * s, 159 * s, 34 * s)));
      const inner = cover(sdRound(x, y, 256 * s, 256 * s, 96 * s, 146 * s, 24 * s));
      const stripe = (((x + y) / s) % 44) < 22 ? [44, 107, 87] : [31, 77, 63];
      mix(stripe, inner);
      // heart: (x²+y²−1)³ − x²y³ ≤ 0, 3×3 supersampling for smooth edges
      let hit = 0;
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
        const hx = ((x + (i + .5) / 3) - 256 * s) / (66 * s);
        const hy = -((y + (j + .5) / 3) - 262 * s) / (66 * s);
        const q = hx * hx + hy * hy - 1;
        if (q * q * q - hx * hx * hy * hy * hy <= 0) hit++;
      }
      const t = Math.min(1, Math.max(0, (x + y - 300 * s) / (260 * s)));
      mix([255 - 38 * t, 179 - 110 * t, 193 - 87 * t], hit / 9);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = rgb[0]; raw[o + 1] = rgb[1]; raw[o + 2] = rgb[2]; raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  writeFileSync(name, png(size));
  console.log('created', name);
}
