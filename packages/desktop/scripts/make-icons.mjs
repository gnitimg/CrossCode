import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

/**
 * Generates the app / tray icons without any image dependency: a tiny
 * anti-aliased rasterizer writes RGBA pixels and a minimal PNG encoder packs
 * them. Mark: a terminal chevron inside a rounded square.
 */

const root = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.resolve(root, '../build');

// --- geometry helpers ------------------------------------------------------

function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Signed distance from point to a line segment. */
function segmentDistance(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lengthSquared = vx * vx + vy * vy;
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Signed distance to a rounded rectangle (negative inside). */
function roundedRectDistance(px, py, left, top, right, bottom, radius) {
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const halfWidth = (right - left) / 2 - radius;
  const halfHeight = (bottom - top) / 2 - radius;
  const qx = Math.abs(px - cx) - halfWidth;
  const qy = Math.abs(py - cy) - halfHeight;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

function blend(dst, offset, r, g, b, alpha) {
  if (alpha <= 0) return;
  const a = Math.min(1, alpha);
  const dstA = dst[offset + 3] / 255;
  const outA = a + dstA * (1 - a);
  if (outA <= 0) return;
  dst[offset] = Math.round((r * a + dst[offset] * dstA * (1 - a)) / outA);
  dst[offset + 1] = Math.round((g * a + dst[offset + 1] * dstA * (1 - a)) / outA);
  dst[offset + 2] = Math.round((b * a + dst[offset + 2] * dstA * (1 - a)) / outA);
  dst[offset + 3] = Math.round(outA * 255);
}

// --- PNG encoder -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) {
    c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---------------------------------------------------------------

/** Draws the mark at the given size; `plate` adds the dark rounded background. */
function renderIcon(size, { plate }) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const stroke = size * 0.075;
  const scale = size;

  // Chevron + underscore glyph, expressed in normalized coordinates.
  const chevron = [
    [0.34, 0.35, 0.53, 0.5],
    [0.53, 0.5, 0.34, 0.65],
  ].map(([ax, ay, bx, by]) => [ax * scale, ay * scale, bx * scale, by * scale]);
  const underscore = [0.58 * scale, 0.65 * scale, 0.72 * scale, 0.65 * scale];
  const glyphThickness = stroke * 0.55;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const offset = (y * size + x) * 4;

      if (plate) {
        const plateDistance = roundedRectDistance(px, py, size * 0.02, size * 0.02, size * 0.98, size * 0.98, size * 0.22);
        const plateAlpha = 1 - smoothstep(-1, 1, plateDistance);
        blend(rgba, offset, 17, 17, 20, plateAlpha);

        const ringDistance = Math.abs(plateDistance + size * 0.055) - size * 0.012;
        const ringAlpha = 1 - smoothstep(-1, 1, ringDistance);
        blend(rgba, offset, 228, 228, 231, ringAlpha * 0.55);
      }

      let glyphDistance = Infinity;
      for (const [ax, ay, bx, by] of chevron) {
        glyphDistance = Math.min(glyphDistance, segmentDistance(px, py, ax, ay, bx, by));
      }
      glyphDistance = Math.min(glyphDistance, segmentDistance(px, py, ...underscore));

      const glyphAlpha = 1 - smoothstep(glyphThickness - 0.8, glyphThickness + 0.8, glyphDistance);
      if (glyphAlpha > 0) {
        blend(rgba, offset, 244, 244, 245, glyphAlpha);
      }
    }
  }
  return rgba;
}

await fs.mkdir(buildDir, { recursive: true });

const icon = encodePng(256, 256, renderIcon(256, { plate: true }));
await fs.writeFile(path.join(buildDir, 'icon.png'), icon);

const tray = encodePng(32, 32, renderIcon(32, { plate: false }));
await fs.writeFile(path.join(buildDir, 'tray.png'), tray);

console.log(`icons written → ${buildDir}`);
