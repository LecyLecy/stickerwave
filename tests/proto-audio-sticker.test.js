import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { proto, encodeWAMessage } from '@whiskeysockets/baileys'
import {
  patchAudioStickerProto,
  inspectWireFields,
  extractAudioStickerInfo,
  PROTO_FIELDS
} from '../src/proto/audio-sticker-proto.js'

patchAudioStickerProto()

function createSampleMediaPayload() {
  return {
    sticker: {
      url: 'https://mmg.whatsapp.net/o1/v/t62.15575-24/fake_sticker.enc',
      directPath: '/o1/v/t62.15575-24/fake_sticker.enc',
      mediaKey: crypto.randomBytes(32),
      fileSha256: crypto.randomBytes(32),
      fileEncSha256: crypto.randomBytes(32),
      fileLength: 12345,
      mimetype: 'image/webp',
      width: 512,
      height: 512,
      isAnimated: false,
      stickerSentTs: Date.now()
    },
    audio: {
      url: 'https://mmg.whatsapp.net/o1/v/t62.7117-24/fake_audio.enc',
      directPath: '/o1/v/t62.7117-24/fake_audio.enc',
      mediaKey: crypto.randomBytes(32),
      fileSha256: crypto.randomBytes(32),
      fileEncSha256: crypto.randomBytes(32),
      fileLength: 6789,
      mimetype: 'audio/ogg; codecs=opus',
      seconds: 3,
      ptt: true,
      waveform: new Uint8Array(64).fill(42)
    }
  }
}

test('Variant A: StickerMessage.audioMessage (field 26) encodes and decodes cleanly', () => {
  const { sticker, audio } = createSampleMediaPayload()
  const message = proto.Message.fromObject({
    stickerMessage: {
      ...sticker,
      emojis: '🔊',
      audioMessage: audio
    }
  })

  // 1. Verify StickerMessage wire bytes contain field 26 (audioMessage) and 25 (emojis)
  const stickerBytes = proto.Message.StickerMessage.encode(message.stickerMessage).finish()
  const stickerFields = inspectWireFields(stickerBytes)
  const audioField = stickerFields.find(
    (f) => f.fieldNumber === PROTO_FIELDS.STICKER_AUDIO_MESSAGE_FIELD && f.wireType === 2
  )
  assert.ok(audioField, 'StickerMessage wire bytes must contain field 26 (wire type 2)')
  assert.ok(audioField.byteLength > 50, 'Nested AudioMessage payload must be non-empty')

  const emojiField = stickerFields.find(
    (f) => f.fieldNumber === PROTO_FIELDS.STICKER_EMOJIS_FIELD && f.wireType === 2
  )
  assert.ok(emojiField, 'StickerMessage wire bytes must contain field 25 (emojis)')

  // 2. Verify full Message round-trip
  const msgBytes = proto.Message.encode(message).finish()
  const decoded = proto.Message.decode(msgBytes)
  assert.ok(decoded.stickerMessage, 'Decoded message must have stickerMessage')
  assert.ok(decoded.stickerMessage.audioMessage, 'Decoded stickerMessage must preserve audioMessage')
  assert.equal(decoded.stickerMessage.mimetype, 'image/webp')
  assert.equal(decoded.stickerMessage.emojis, '🔊')
  assert.equal(decoded.stickerMessage.audioMessage.mimetype, 'audio/ogg; codecs=opus')
  assert.equal(decoded.stickerMessage.audioMessage.seconds, 3)
  assert.equal(decoded.stickerMessage.audioMessage.ptt, true)
  assert.equal(Buffer.from(decoded.stickerMessage.audioMessage.mediaKey).length, 32)
  assert.equal(decoded.stickerMessage.audioMessage.waveform.length, 64)

  // 3. Verify Baileys encodeWAMessage (which adds PKCS7-like padding) preserves nested audioMessage
  const padded = encodeWAMessage(message)
  const padLen = padded[padded.length - 1]
  const unpadded = padded.subarray(0, padded.length - padLen)
  const decodedFromBaileys = proto.Message.decode(unpadded)
  assert.ok(decodedFromBaileys.stickerMessage?.audioMessage, 'encodeWAMessage must preserve field 26')

  // 4. Verify extractor helper
  const info = extractAudioStickerInfo(decodedFromBaileys)
  assert.equal(info.wrappedInAudioSticker, false)
  assert.equal(info.hasNestedAudio, true)
  assert.equal(info.audio.seconds, 3)
})

test('Variant B: Message.audioStickerMessage (field 134) wrapping StickerMessage.audioMessage (field 26)', () => {
  const { sticker, audio } = createSampleMediaPayload()
  const message = proto.Message.fromObject({
    audioStickerMessage: {
      message: {
        stickerMessage: {
          ...sticker,
          audioMessage: audio
        }
      }
    }
  })

  // 1. Verify top-level wire bytes contain field 134 (wire type 2)
  const msgBytes = proto.Message.encode(message).finish()
  const topFields = inspectWireFields(msgBytes)
  const wrapperField = topFields.find(
    (f) => f.fieldNumber === PROTO_FIELDS.MESSAGE_AUDIO_STICKER_FIELD && f.wireType === 2
  )
  assert.ok(wrapperField, 'Message wire bytes must contain field 134 (audioStickerMessage)')

  // 2. Verify full round-trip decode preserves BOTH wrapper (134) and nested audioMessage (26)
  const decoded = proto.Message.decode(msgBytes)
  assert.ok(decoded.audioStickerMessage?.message?.stickerMessage, 'Decoded wrapper must contain stickerMessage')
  assert.ok(
    decoded.audioStickerMessage.message.stickerMessage.audioMessage,
    'Decoded wrapped stickerMessage must preserve audioMessage'
  )
  assert.equal(
    decoded.audioStickerMessage.message.stickerMessage.audioMessage.mimetype,
    'audio/ogg; codecs=opus'
  )

  // 3. Verify extractor helper
  const info = extractAudioStickerInfo(decoded)
  assert.equal(info.wrappedInAudioSticker, true)
  assert.equal(info.hasNestedAudio, true)
  assert.equal(info.sticker.width, 512)
  assert.equal(info.audio.ptt, true)
})
