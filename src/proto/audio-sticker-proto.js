import $protobuf from 'protobufjs/minimal.js'
import { proto } from '@whiskeysockets/baileys'

const $Reader = $protobuf.Reader
const $Writer = $protobuf.Writer

// Verified against WhatsApp Android 2.26.41.6 & wppconnect-team/wa-proto:
// - StickerMessage.premium = 24 (varint -> tag (24 << 3) | 0 = 192)
// - StickerMessage.emojis = 25 (length-delimited -> tag (25 << 3) | 2 = 202)
// - StickerMessage.oneof audio { Message.AudioMessage audioMessage = 26; } (length-delimited -> tag (26 << 3) | 2 = 210)
// - Message.FutureProofMessage audioStickerMessage = 134 (length-delimited -> tag (134 << 3) | 2 = 1074)
export const PROTO_FIELDS = Object.freeze({
  STICKER_PREMIUM_FIELD: 24,
  STICKER_EMOJIS_FIELD: 25,
  STICKER_AUDIO_MESSAGE_FIELD: 26,
  MESSAGE_AUDIO_STICKER_FIELD: 134,
  TAG_STICKER_PREMIUM: (24 << 3) | 0,
  TAG_STICKER_EMOJIS: (25 << 3) | 2,
  TAG_STICKER_AUDIO_MESSAGE: (26 << 3) | 2,
  TAG_MESSAGE_AUDIO_STICKER: (134 << 3) | 2
})

let patched = false

function extractSliceForRescan(readerOrBytes, length) {
  if (readerOrBytes instanceof $Reader) {
    const start = readerOrBytes.pos
    const end = length === undefined ? readerOrBytes.len : start + length
    return {
      reader: readerOrBytes,
      slice: readerOrBytes.buf.subarray(start, end)
    }
  }
  const buf = readerOrBytes instanceof Uint8Array ? readerOrBytes : new Uint8Array(readerOrBytes)
  const slice = length === undefined ? buf : buf.subarray(0, length)
  return {
    reader: $Reader.create(buf),
    slice
  }
}

export function patchAudioStickerProto() {
  if (patched) return { alreadyPatched: true }

  const Message = proto.Message
  const StickerMessage = proto.Message.StickerMessage
  const AudioMessage = proto.Message.AudioMessage
  const FutureProofMessage = proto.Message.FutureProofMessage

  if (!Message || !StickerMessage || !AudioMessage || !FutureProofMessage) {
    throw new Error('Skema WAProto dari Baileys tidak lengkap untuk patch Audio Sticker.')
  }

  // --- 1. Patch StickerMessage (fields 24, 25, 26) ---
  if (!('premium' in StickerMessage.prototype)) {
    StickerMessage.prototype.premium = 0
  }
  if (!('emojis' in StickerMessage.prototype)) {
    StickerMessage.prototype.emojis = ''
  }
  if (!('audioMessage' in StickerMessage.prototype)) {
    StickerMessage.prototype.audioMessage = null
  }

  const origStickerEncode = StickerMessage.encode
  StickerMessage.encode = function encodePatched(m, w) {
    if (!w) w = $Writer.create()
    origStickerEncode.call(this, m, w)
    if (m) {
      if (m.premium != null && Object.prototype.hasOwnProperty.call(m, 'premium')) {
        w.uint32(PROTO_FIELDS.TAG_STICKER_PREMIUM).int32(m.premium)
      }
      if (m.emojis != null && Object.prototype.hasOwnProperty.call(m, 'emojis')) {
        w.uint32(PROTO_FIELDS.TAG_STICKER_EMOJIS).string(m.emojis)
      }
      if (m.audioMessage != null && Object.prototype.hasOwnProperty.call(m, 'audioMessage')) {
        AudioMessage.encode(m.audioMessage, w.uint32(PROTO_FIELDS.TAG_STICKER_AUDIO_MESSAGE).fork()).ldelim()
      }
    }
    return w
  }

  const origStickerDecode = StickerMessage.decode
  StickerMessage.decode = function decodePatched(r, l, e) {
    const { reader, slice } = extractSliceForRescan(r, l)
    const decoded = origStickerDecode.call(this, reader, l, e)

    const scan = $Reader.create(slice)
    while (scan.pos < scan.len) {
      const t = scan.uint32()
      if (t === e) break
      const fieldNo = t >>> 3
      const wireType = t & 7
      if (fieldNo === PROTO_FIELDS.STICKER_PREMIUM_FIELD && wireType === 0) {
        decoded.premium = scan.int32()
      } else if (fieldNo === PROTO_FIELDS.STICKER_EMOJIS_FIELD && wireType === 2) {
        decoded.emojis = scan.string()
      } else if (fieldNo === PROTO_FIELDS.STICKER_AUDIO_MESSAGE_FIELD && wireType === 2) {
        decoded.audioMessage = AudioMessage.decode(scan, scan.uint32())
      } else {
        scan.skipType(wireType)
      }
    }
    return decoded
  }

  const origStickerFromObject = StickerMessage.fromObject
  StickerMessage.fromObject = function fromObjectPatched(d) {
    if (d instanceof StickerMessage) return d
    const obj = origStickerFromObject.call(this, d)
    if (d && typeof d === 'object') {
      if (d.premium != null) obj.premium = d.premium | 0
      if (d.emojis != null) obj.emojis = String(d.emojis)
      if (d.audioMessage != null) {
        if (typeof d.audioMessage !== 'object') {
          throw new TypeError('.proto.Message.StickerMessage.audioMessage: object expected')
        }
        obj.audioMessage = AudioMessage.fromObject(d.audioMessage)
      }
    }
    return obj
  }

  const origStickerToObject = StickerMessage.toObject
  StickerMessage.toObject = function toObjectPatched(m, o) {
    const out = origStickerToObject.call(this, m, o)
    if (m) {
      if (m.premium != null && Object.prototype.hasOwnProperty.call(m, 'premium')) {
        out.premium = m.premium
      }
      if (m.emojis != null && Object.prototype.hasOwnProperty.call(m, 'emojis')) {
        out.emojis = m.emojis
      }
      if (m.audioMessage != null && Object.prototype.hasOwnProperty.call(m, 'audioMessage')) {
        out.audioMessage = AudioMessage.toObject(m.audioMessage, o)
      }
    }
    return out
  }

  const origStickerCreate = StickerMessage.create
  StickerMessage.create = function createPatched(properties) {
    const instance = origStickerCreate.call(this, properties)
    if (properties && typeof properties === 'object') {
      if (properties.premium != null) instance.premium = properties.premium | 0
      if (properties.emojis != null) instance.emojis = String(properties.emojis)
      if (properties.audioMessage != null) {
        instance.audioMessage =
          properties.audioMessage instanceof AudioMessage
            ? properties.audioMessage
            : AudioMessage.create(properties.audioMessage)
      }
    }
    return instance
  }

  // --- 2. Patch Message (field 134: audioStickerMessage) ---
  if (!('audioStickerMessage' in Message.prototype)) {
    Message.prototype.audioStickerMessage = null
  }

  const origMessageEncode = Message.encode
  Message.encode = function encodeMessagePatched(m, w) {
    if (!w) w = $Writer.create()
    origMessageEncode.call(this, m, w)
    if (m && m.audioStickerMessage != null && Object.prototype.hasOwnProperty.call(m, 'audioStickerMessage')) {
      FutureProofMessage.encode(
        m.audioStickerMessage,
        w.uint32(PROTO_FIELDS.TAG_MESSAGE_AUDIO_STICKER).fork()
      ).ldelim()
    }
    return w
  }

  const origMessageDecode = Message.decode
  Message.decode = function decodeMessagePatched(r, l, e) {
    const { reader, slice } = extractSliceForRescan(r, l)
    const decoded = origMessageDecode.call(this, reader, l, e)

    const scan = $Reader.create(slice)
    while (scan.pos < scan.len) {
      const t = scan.uint32()
      if (t === e) break
      const fieldNo = t >>> 3
      const wireType = t & 7
      if (fieldNo === PROTO_FIELDS.MESSAGE_AUDIO_STICKER_FIELD && wireType === 2) {
        decoded.audioStickerMessage = FutureProofMessage.decode(scan, scan.uint32())
      } else {
        scan.skipType(wireType)
      }
    }
    return decoded
  }

  const origMessageFromObject = Message.fromObject
  Message.fromObject = function fromObjectMessagePatched(d) {
    if (d instanceof Message) return d
    const obj = origMessageFromObject.call(this, d)
    if (d && typeof d === 'object' && d.audioStickerMessage != null) {
      if (typeof d.audioStickerMessage !== 'object') {
        throw new TypeError('.proto.Message.audioStickerMessage: object expected')
      }
      obj.audioStickerMessage = FutureProofMessage.fromObject(d.audioStickerMessage)
    }
    return obj
  }

  const origMessageToObject = Message.toObject
  Message.toObject = function toObjectMessagePatched(m, o) {
    const out = origMessageToObject.call(this, m, o)
    if (m && m.audioStickerMessage != null && Object.prototype.hasOwnProperty.call(m, 'audioStickerMessage')) {
      out.audioStickerMessage = FutureProofMessage.toObject(m.audioStickerMessage, o)
    }
    return out
  }

  const origMessageCreate = Message.create
  Message.create = function createMessagePatched(properties) {
    const instance = origMessageCreate.call(this, properties)
    if (properties && typeof properties === 'object' && properties.audioStickerMessage != null) {
      instance.audioStickerMessage =
        properties.audioStickerMessage instanceof FutureProofMessage
          ? properties.audioStickerMessage
          : FutureProofMessage.create(properties.audioStickerMessage)
    }
    return instance
  }

  patched = true
  return { alreadyPatched: false }
}

/**
 * Inspect raw Protobuf wire fields of a serialized Message buffer (top-level & StickerMessage level).
 */
export function inspectWireFields(bytes) {
  const fields = []
  const reader = $Reader.create(bytes)
  while (reader.pos < reader.len) {
    const tag = reader.uint32()
    const fieldNumber = tag >>> 3
    const wireType = tag & 7
    const valueStart = reader.pos
    reader.skipType(wireType)
    fields.push({
      fieldNumber,
      wireType,
      byteLength: reader.pos - valueStart
    })
  }
  return fields
}

/**
 * Unwrap a Message (including audioStickerMessage field 134) and extract audio sticker details.
 */
export function extractAudioStickerInfo(rawMessage) {
  if (!rawMessage || typeof rawMessage !== 'object') return null

  const wrappedInAudioSticker = Boolean(rawMessage.audioStickerMessage?.message)
  const inner = wrappedInAudioSticker
    ? rawMessage.audioStickerMessage.message
    : rawMessage.ephemeralMessage?.message ||
      rawMessage.viewOnceMessage?.message ||
      rawMessage.viewOnceMessageV2?.message ||
      rawMessage

  const sticker = inner?.stickerMessage
  if (!sticker) return null

  const audio = sticker.audioMessage || null
  return {
    wrappedInAudioSticker,
    hasNestedAudio: Boolean(audio),
    sticker: {
      mimetype: sticker.mimetype || null,
      width: sticker.width || null,
      height: sticker.height || null,
      isAnimated: Boolean(sticker.isAnimated),
      fileLength: sticker.fileLength ? Number(sticker.fileLength) : null,
      hasUrl: Boolean(sticker.url),
      hasDirectPath: Boolean(sticker.directPath),
      hasMediaKey: Boolean(sticker.mediaKey && sticker.mediaKey.length > 0),
      emojis: sticker.emojis || null
    },
    audio: audio
      ? {
          mimetype: audio.mimetype || null,
          seconds: audio.seconds ?? null,
          ptt: Boolean(audio.ptt),
          fileLength: audio.fileLength ? Number(audio.fileLength) : null,
          hasUrl: Boolean(audio.url),
          hasDirectPath: Boolean(audio.directPath),
          hasMediaKey: Boolean(audio.mediaKey && audio.mediaKey.length > 0),
          waveformBytes: audio.waveform ? audio.waveform.length : 0
        }
      : null
  }
}
