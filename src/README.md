# `src/`

Core Node.js backend that powers Stickerwave's local HTTP server, WhatsApp connection, media conversion pipeline, and native Audio Sticker delivery.

## Files

- `index.js` — Application entry point; starts the local HTTP server, opens the browser, and connects Baileys to WhatsApp.
- `server.js` — HTTP server serving `public/` static assets and API routes:
  - `GET /api/status` — Current WhatsApp connection state, QR data URL, and studio limits.
  - `GET /api/events` — Server-Sent Events (SSE) stream for live connection/QR updates.
  - `POST /api/pair` — Requests an 8-digit WhatsApp Pairing Code for phone login.
  - `POST /api/logout` — Unlinks WhatsApp, clears local `auth/`, and generates a fresh QR code.
  - `POST /api/send-sticker` — Processes visual/audio uploads with FFmpeg and sends the sticker to your personal chat.
- `connection.js` — Baileys v7 socket lifecycle, in-memory QR code generation, Pairing Code, reconnect handling, and session reset on logout.
- `config.js` — Loads `.env` settings and resolves bundled FFmpeg/FFprobe binaries.

## Subfolders

- [`proto/`](./proto/README.md) — Protobuf runtime patch for WhatsApp Native Audio Stickers.
- [`services/`](./services/README.md) — Media conversion, EXIF injection, and encrypted WhatsApp sticker uploading/sending.
- [`utils/`](./utils/README.md) — Temp directory cleanup, concurrency queue, and redacted logging.
