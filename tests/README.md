# `tests/`

Automated tests using Node.js's built-in test runner (`node:test`). Run all tests from the project root with:

```bash
npm test
```

## Files

- `proto-audio-sticker.test.js` — Verifies that `StickerMessage.audioMessage` (field `26`) survives Protobuf encoding and decoding.
- `media-converter.test.js` — Tests FFmpeg conversion for static images, animated videos, GIFs, OGG Opus audio, 1:1 crop modes, duration limits, error handling, and temp cleanup.
- `desktop-server.test.js` — End-to-end HTTP tests covering the Connect-First QR Gate, `POST /api/logout`, required sticker name validation, max duration enforcement, synced video/audio override (`2s..5s` video + audio starting at `3s` → `3s..6s`), EXIF watermark injection, self-chat relay, and temp cleanup.
