# `public/`

Static frontend files served by the local Stickerwave server (`http://127.0.0.1:3456`). Built with plain HTML, CSS, and vanilla JavaScript — no build step required.

## Files

- `index.html` — Page layout containing the first-time **Connect QR Gate** (`#connectGate`), the **Studio Editor** (`#studioApp`), and the **Logout** confirmation modal.
- `styles.css` — Dark studio theme styling, responsive layout, 1:1 sticker frame, and CapCut-style draggable timeline tracks.
- `app.js` — Client logic for SSE WhatsApp status updates, connect gate locking, logout, single visual upload, interactive 1:1 crop dragging, filmstrip/waveform rendering, synced video/audio playback, and sending stickers.
- `logo.png` — Stickerwave app logo used for the browser favicon, Connect screen, and top navigation bar.
