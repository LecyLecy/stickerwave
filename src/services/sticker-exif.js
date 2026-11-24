import crypto from 'node:crypto'

const RIFF_HEADER = Buffer.from('RIFF', 'ascii')
const WEBP_HEADER = Buffer.from('WEBP', 'ascii')
const EXIF_HEADER = Buffer.from([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x16, 0x00, 0x00, 0x00
])

/**
 * Builds the WhatsApp sticker EXIF payload containing pack name, author, and emojis.
 */
export function buildWhatsAppExifPayload({
  packName = 'Personal Audio Stickers',
  author = 'Adin',
  emojis = ['🔊'],
  packId = null
} = {}) {
  const json = {
    'sticker-pack-id': packId || crypto.randomUUID(),
    'sticker-pack-name': String(packName),
    'sticker-pack-publisher': String(author),
    emojis: Array.isArray(emojis) ? emojis : [String(emojis)]
  }
  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8')
  const exif = Buffer.concat([EXIF_HEADER, jsonBuffer])
  exif.writeUInt32LE(jsonBuffer.length, 14)
  return exif
}

function parseWebpChunks(webpBuffer) {
  if (
    !Buffer.isBuffer(webpBuffer) ||
    webpBuffer.length < 12 ||
    !webpBuffer.subarray(0, 4).equals(RIFF_HEADER) ||
    !webpBuffer.subarray(8, 12).equals(WEBP_HEADER)
  ) {
    throw new Error('File bukan format WebP (RIFF/WEBP) yang valid.')
  }

  const chunks = []
  let offset = 12
  while (offset + 8 <= webpBuffer.length) {
    const fourcc = webpBuffer.subarray(offset, offset + 4).toString('ascii')
    const size = webpBuffer.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + size
    if (dataEnd > webpBuffer.length) break
    chunks.push({
      fourcc,
      data: webpBuffer.subarray(dataStart, dataEnd)
    })
    offset = dataEnd + (size % 2) // RIFF chunks are padded to even byte boundaries
  }
  return chunks
}

function getDimensionsFromVp8(data) {
  // VP8 lossy bitstream frame header: bytes 6..9 hold 14-bit width & height after start code 0x9d 0x01 0x2a
  if (data.length >= 10 && data[3] === 0x9d && data[4] === 0x01 && data[5] === 0x2a) {
    const width = data.readUInt16LE(6) & 0x3fff
    const height = data.readUInt16LE(8) & 0x3fff
    return { width, height }
  }
  return { width: 512, height: 512 }
}

function getDimensionsFromVp8L(data) {
  // VP8L lossless header: byte 0 = 0x2f, next 4 bytes hold 14-bit (width-1) and 14-bit (height-1)
  if (data.length >= 5 && data[0] === 0x2f) {
    const bits = data.readUInt32LE(1)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >>> 14) & 0x3fff) + 1
    return { width, height }
  }
  return { width: 512, height: 512 }
}

function encodeChunk(fourcc, data) {
  const header = Buffer.alloc(8)
  header.write(fourcc, 0, 4, 'ascii')
  header.writeUInt32LE(data.length, 4)
  if (data.length % 2 === 1) {
    return Buffer.concat([header, data, Buffer.from([0x00])])
  }
  return Buffer.concat([header, data])
}

/**
 * Injects WhatsApp Sticker EXIF metadata (pack name & author) into a static or animated WebP buffer
 * using pure Node.js RIFF chunk manipulation (no native WebP tooling required).
 */
export function injectStickerExif(webpBuffer, metadata = {}) {
  const chunks = parseWebpChunks(webpBuffer)
  const exifData = buildWhatsAppExifPayload(metadata)

  // Remove any existing EXIF chunk
  const filtered = chunks.filter((c) => c.fourcc !== 'EXIF')

  const vp8xIndex = filtered.findIndex((c) => c.fourcc === 'VP8X')
  if (vp8xIndex !== -1) {
    // Update existing VP8X chunk: set EXIF flag (bit 3 -> 0x08)
    const vp8xCopy = Buffer.from(filtered[vp8xIndex].data)
    if (vp8xCopy.length >= 10) {
      vp8xCopy[0] = vp8xCopy[0] | 0x08
      filtered[vp8xIndex] = { fourcc: 'VP8X', data: vp8xCopy }
    }
  } else {
    // Simple WebP (VP8 / VP8L): promote to extended VP8X WebP so EXIF chunk is valid per WebP spec
    const hasAlpha = filtered.some((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8L')
    let dims = { width: 512, height: 512 }
    const vp8Chunk = filtered.find((c) => c.fourcc === 'VP8 ')
    const vp8lChunk = filtered.find((c) => c.fourcc === 'VP8L')
    if (vp8Chunk) dims = getDimensionsFromVp8(vp8Chunk.data)
    else if (vp8lChunk) dims = getDimensionsFromVp8L(vp8lChunk.data)

    const vp8x = Buffer.alloc(10)
    // Flags byte: bit 3 = EXIF (0x08), bit 4 = Alpha (0x10)
    vp8x[0] = 0x08 | (hasAlpha ? 0x10 : 0x00)
    const wMinus1 = Math.max(0, (dims.width || 512) - 1)
    const hMinus1 = Math.max(0, (dims.height || 512) - 1)
    vp8x[4] = wMinus1 & 0xff
    vp8x[5] = (wMinus1 >> 8) & 0xff
    vp8x[6] = (wMinus1 >> 16) & 0xff
    vp8x[7] = hMinus1 & 0xff
    vp8x[8] = (hMinus1 >> 8) & 0xff
    vp8x[9] = (hMinus1 >> 16) & 0xff

    filtered.unshift({ fourcc: 'VP8X', data: vp8x })
  }

  filtered.push({ fourcc: 'EXIF', data: exifData })

  const encodedChunks = filtered.map((c) => encodeChunk(c.fourcc, c.data))
  const body = Buffer.concat(encodedChunks)
  const riffSize = Buffer.alloc(4)
  riffSize.writeUInt32LE(4 + body.length, 0)

  return Buffer.concat([RIFF_HEADER, riffSize, WEBP_HEADER, body])
}

/**
 * Checks whether a WebP buffer is animated (contains ANIM/ANMF chunks or VP8X animation bit 0x02).
 */
export function isAnimatedWebp(webpBuffer) {
  try {
    const chunks = parseWebpChunks(webpBuffer)
    if (chunks.some((c) => c.fourcc === 'ANIM' || c.fourcc === 'ANMF')) return true
    const vp8x = chunks.find((c) => c.fourcc === 'VP8X')
    if (vp8x && vp8x.data.length >= 1 && (vp8x.data[0] & 0x02) !== 0) return true
    return false
  } catch {
    return false
  }
}
