import fs from 'node:fs/promises'
import {
  encodeWAMessage,
  generateMessageIDV2,
  prepareWAMessageMedia,
  proto
} from '@whiskeysockets/baileys'
import {
  extractAudioStickerInfo,
  inspectWireFields,
  patchAudioStickerProto,
  PROTO_FIELDS
} from '../proto/audio-sticker-proto.js'
import { baileysLogger } from '../utils/logger.js'

patchAudioStickerProto()

export const AUDIO_STICKER_VARIANTS = Object.freeze({
  A: 'a', // Direct StickerMessage.audioMessage (field 26) with ptt: true
  B: 'b', // Wrapped in Message.audioStickerMessage (field 134) — verified NOT rendered by WA
  C: 'c'  // Direct StickerMessage.audioMessage (field 26) with ptt: false — VERIFIED WORKING on Android Beta & WA Web
})

export const DEFAULT_VERIFIED_VARIANT = AUDIO_STICKER_VARIANTS.C

/**
 * Verifies that an outgoing proto.Message actually retains the nested AudioMessage
 * after real Protobuf serialization via Baileys' encodeWAMessage().
 */
export function verifyEncodedAudioSticker(message) {
  const rawBytes = proto.Message.encode(message).finish()
  const topWireFields = inspectWireFields(rawBytes)

  const paddedBytes = encodeWAMessage(message)
  const padLen = paddedBytes[paddedBytes.length - 1]
  const unpadded = paddedBytes.subarray(0, paddedBytes.length - padLen)
  const decoded = proto.Message.decode(unpadded)

  const info = extractAudioStickerInfo(decoded)
  if (!info || !info.hasNestedAudio) {
    throw new Error('Verifikasi Protobuf gagal: field audioMessage hilang setelah serialisasi!')
  }

  const innerSticker = info.wrappedInAudioSticker
    ? decoded.audioStickerMessage.message.stickerMessage
    : decoded.stickerMessage
  const stickerWireFields = inspectWireFields(proto.Message.StickerMessage.encode(innerSticker).finish())
  const hasField26 = stickerWireFields.some(
    (f) => f.fieldNumber === PROTO_FIELDS.STICKER_AUDIO_MESSAGE_FIELD && f.wireType === 2
  )
  const hasField134 = topWireFields.some(
    (f) => f.fieldNumber === PROTO_FIELDS.MESSAGE_AUDIO_STICKER_FIELD && f.wireType === 2
  )

  return {
    wireByteLength: rawBytes.length,
    paddedByteLength: paddedBytes.length,
    hasField26,
    hasField134,
    info
  }
}

/**
 * Uploads the WebP sticker and OGG Opus audio separately via Baileys' media pipeline,
 * builds the verified native Audio Sticker Protobuf payload, verifies wire serialization, and relays it.
 */
export async function sendNativeAudioSticker(sock, jid, {
  stickerPath,
  audioPath,
  stickerBuffer,
  audioBuffer,
  isAnimated = false,
  width = 512,
  height = 512,
  seconds,
  emojis = '🔊',
  variant = DEFAULT_VERIFIED_VARIANT,
  quotedMessage = null,
  onBeforeRelay = null
}) {
  const stickerBytes = stickerBuffer || (await fs.readFile(stickerPath))
  const audioBytes = audioBuffer || (await fs.readFile(audioPath))

  const ptt = variant !== AUDIO_STICKER_VARIANTS.C

  // 1. Encrypt & upload sticker via WhatsApp Image Keys pipeline
  const preparedSticker = await prepareWAMessageMedia(
    {
      sticker: stickerBytes,
      isAnimated: Boolean(isAnimated),
      width,
      height,
      mimetype: 'image/webp'
    },
    {
      upload: sock.waUploadToServer,
      logger: baileysLogger
    }
  )

  if (!preparedSticker?.stickerMessage) {
    throw new Error('Gagal menyiapkan media stiker (stickerMessage kosong).')
  }

  // 2. Encrypt & upload audio separately via WhatsApp Audio Keys pipeline
  const preparedAudio = await prepareWAMessageMedia(
    {
      audio: audioBytes,
      mimetype: 'audio/ogg; codecs=opus',
      ptt,
      ...(typeof seconds === 'number' && seconds > 0 ? { seconds: Math.round(seconds) } : {})
    },
    {
      upload: sock.waUploadToServer,
      logger: baileysLogger
    }
  )

  if (!preparedAudio?.audioMessage) {
    throw new Error('Gagal menyiapkan media audio (audioMessage kosong).')
  }

  // 3. Construct combined native Audio Sticker Protobuf payload
  const stickerPayload = {
    ...proto.Message.StickerMessage.toObject(preparedSticker.stickerMessage),
    width,
    height,
    isAnimated: Boolean(isAnimated),
    stickerSentTs: Date.now(),
    ...(emojis ? { emojis } : {}),
    audioMessage: proto.Message.AudioMessage.toObject(preparedAudio.audioMessage)
  }

  if (quotedMessage?.key?.id) {
    stickerPayload.contextInfo = {
      stanzaId: quotedMessage.key.id,
      participant: quotedMessage.key.participant || quotedMessage.key.remoteJid,
      quotedMessage: quotedMessage.message
    }
  }

  const messageId = generateMessageIDV2(sock.user?.id)
  if (onBeforeRelay) onBeforeRelay(messageId)

  let message
  const relayOptions = { messageId }

  if (variant === AUDIO_STICKER_VARIANTS.B) {
    message = proto.Message.fromObject({
      audioStickerMessage: {
        message: {
          stickerMessage: stickerPayload
        }
      }
    })
    relayOptions.additionalAttributes = {
      type: 'media',
      mediatype: 'sticker'
    }
  } else {
    message = proto.Message.fromObject({
      stickerMessage: stickerPayload
    })
  }

  // 4. Verify serialized wire bytes BEFORE sending to WhatsApp servers
  const verification = verifyEncodedAudioSticker(message)

  // 5. Relay raw Protobuf message through Baileys socket
  const relayedId = await sock.relayMessage(jid, message, relayOptions)

  return {
    messageId: relayedId || messageId,
    variant,
    ptt,
    verification
  }
}

/**
 * Sends a normal (silent) WhatsApp sticker using the same verified pipeline.
 */
export async function sendNormalSticker(sock, jid, {
  stickerPath,
  stickerBuffer,
  isAnimated = false,
  width = 512,
  height = 512,
  quotedMessage = null,
  onBeforeRelay = null
}) {
  const stickerBytes = stickerBuffer || (await fs.readFile(stickerPath))
  const preparedSticker = await prepareWAMessageMedia(
    {
      sticker: stickerBytes,
      isAnimated: Boolean(isAnimated),
      width,
      height,
      mimetype: 'image/webp'
    },
    {
      upload: sock.waUploadToServer,
      logger: baileysLogger
    }
  )

  const stickerPayload = {
    ...proto.Message.StickerMessage.toObject(preparedSticker.stickerMessage),
    width,
    height,
    isAnimated: Boolean(isAnimated),
    stickerSentTs: Date.now()
  }

  if (quotedMessage?.key?.id) {
    stickerPayload.contextInfo = {
      stanzaId: quotedMessage.key.id,
      participant: quotedMessage.key.participant || quotedMessage.key.remoteJid,
      quotedMessage: quotedMessage.message
    }
  }

  const messageId = generateMessageIDV2(sock.user?.id)
  if (onBeforeRelay) onBeforeRelay(messageId)

  const message = proto.Message.fromObject({ stickerMessage: stickerPayload })
  const relayedId = await sock.relayMessage(jid, message, { messageId })
  return { messageId: relayedId || messageId }
}
