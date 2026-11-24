# `src/proto/`

Runtime Protobuf schema extension for WhatsApp Native Audio Stickers.

## Files

- `audio-sticker-proto.js` — Patches `@whiskeysockets/baileys`'s `WAProto` at runtime so `StickerMessage` supports `audioMessage` (field `26`), `emojis` (field `25`), and `premium` (field `24`) across `encode`, `decode`, `fromObject`, and `toObject`. Also provides wire-level inspection helpers used to verify payloads before sending.
