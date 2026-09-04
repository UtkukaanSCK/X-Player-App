import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Draws the application icon.
 *
 * Written by hand rather than pulled from a design tool so the mark is
 * reproducible from source and matches the palette the rest of the app uses:
 * graphite ground, broadcast amber stroke. electron-builder turns this single
 * PNG into the .ico and .icns it needs.
 *
 * No image library, because adding a dependency to draw two lines would be a
 * poor trade. Anti-aliasing comes from measuring each pixel's distance to the
 * shape rather than from a rasteriser.
 */
const SIZE = 1024
const OUT = 'build'

const GROUND = [0x13, 0x14, 0x17]
const AMBER = [0xff, 0xb0, 0x20]

/** Signed distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Signed distance to a rounded rectangle, negative inside. */
function distanceToRoundedRect(px, py, halfW, halfH, radius) {
  const qx = Math.abs(px) - halfW + radius
  const qy = Math.abs(py) - halfH + radius
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius
}

/** 0 at and beyond the edge, 1 well inside, smooth across one pixel. */
const coverage = (distance) => Math.max(0, Math.min(1, 0.5 - distance))

function render() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const centre = SIZE / 2
  const radius = SIZE * 0.234
  const half = SIZE / 2
  const inset = SIZE * 0.285
  const strokeHalf = SIZE * 0.055

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const px = x + 0.5
      const py = y + 0.5

      const inShape = coverage(distanceToRoundedRect(px - centre, py - centre, half, half, radius))
      const onStroke = Math.max(
        coverage(distanceToSegment(px, py, inset, inset, SIZE - inset, SIZE - inset) - strokeHalf),
        coverage(distanceToSegment(px, py, SIZE - inset, inset, inset, SIZE - inset) - strokeHalf),
      )

      const offset = (y * SIZE + x) * 4
      for (let c = 0; c < 3; c++) {
        pixels[offset + c] = Math.round(GROUND[c] * (1 - onStroke) + AMBER[c] * onStroke)
      }
      // The stroke never reaches the corners, so the shape alone sets opacity.
      pixels[offset + 3] = Math.round(inShape * 255)
    }
  }
  return pixels
}

/* ------------------------------------------------------------------- encoding */

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(SIZE, 0)
  header.writeUInt32BE(SIZE, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  // compression, filter and interlace methods: the only ones PNG defines.

  // Every scanline is prefixed with filter type 0, meaning stored as-is.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    const from = y * SIZE * 4
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, from, from + SIZE * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

mkdirSync(OUT, { recursive: true })
const png = encodePng(render())
const path = join(OUT, 'icon.png')
writeFileSync(path, png)
console.log(`${path}  ${SIZE}x${SIZE}  ${(png.length / 1024).toFixed(1)} kB`)
