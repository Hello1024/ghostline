/**
 * Generate the app icons.
 *
 * Written by hand rather than pulled from a design tool so the repo has no
 * binary assets it cannot regenerate: `npm run icons` rebuilds them exactly.
 * A tiny PNG encoder (zlib is in Node) is all it takes.
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {(x:number,y:number)=>[number,number,number,number]} shade */
function png(size, shade) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0;                       // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = shade(x, y);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 6;      // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, t))));

/**
 * A pulse going out and a single figure caught in it — the whole game in one
 * mark. `inset` leaves room for a maskable icon's safe zone.
 */
function icon(size, { inset = 0 } = {}) {
  const c = size / 2;
  const scale = (size / 2) * (1 - inset);
  const BG = [10, 13, 18];
  const RING = [55, 226, 200];
  const GHOST = [169, 139, 255];
  return (x, y) => {
    const dx = (x - c) / scale;
    const dy = (y - c) / scale;
    const d = Math.hypot(dx, dy);
    let px = BG;

    // Three rings, fading outward.
    for (const [r, w, alpha] of [[0.34, 0.055, 1], [0.58, 0.045, 0.66], [0.82, 0.035, 0.36]]) {
      const edge = Math.abs(d - r);
      if (edge < w) px = mix(px, RING, (1 - edge / w) * alpha);
    }

    // The figure, off-centre and inside the innermost ring.
    const gx = dx + 0.1;
    const gy = dy + 0.04;
    const head = Math.hypot(gx, gy + 0.10) - 0.085;
    const body = Math.hypot(gx / 1.02, (gy - 0.075) / 1.25) - 0.115;
    const blob = Math.min(head, body);
    if (blob < 0) px = mix(px, GHOST, 1);
    else if (blob < 0.02) px = mix(px, GHOST, 1 - blob / 0.02);

    if (d > 1) return [...BG, 0];
    return [...px, 255];
  };
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'icon-192.png'), png(192, icon(192)));
writeFileSync(join(OUT, 'icon-512.png'), png(512, icon(512)));
writeFileSync(join(OUT, 'icon-maskable-512.png'), png(512, icon(512, { inset: 0.18 })));
writeFileSync(join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0a0d12"/>
  <g fill="none" stroke="#37e2c8" stroke-width="2.6">
    <circle cx="50" cy="50" r="17"/>
    <circle cx="50" cy="50" r="29" opacity=".66"/>
    <circle cx="50" cy="50" r="41" opacity=".36"/>
  </g>
  <g fill="#a98bff" transform="translate(-5,-2)">
    <circle cx="50" cy="45" r="4.3"/>
    <ellipse cx="50" cy="53.8" rx="5.8" ry="7.2"/>
  </g>
</svg>\n`);

console.log('icons written to', OUT);
