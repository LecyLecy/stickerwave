# `src/services/`

Media processing, sticker metadata injection, and WhatsApp message relay services.

## Files

- `media-converter.js` — Inspects media with FFprobe and converts inputs via FFmpeg:
  - Images → `512×512` static WebP (`≤ 100 KB`).
  - Videos / GIFs → `512×512` animated WebP (`≤ 490 KB` with adaptive compression) trimmed to exact start/duration and 1:1 crop coordinates.
  - Audio / video soundtracks → `48 kHz` mono OGG Opus (`32 kbps`) trimmed and synced to video length.
- `sticker-exif.js` — Pure-Node RIFF/WebP `EXIF` chunk injector that embeds the sticker pack name, publisher watermark, and emojis into static and animated WebP files.
- `audio-sticker-sender.js` — Encrypts and uploads WebP visual media and OGG Opus audio independently through Baileys, verifies wire serialization (`StickerMessage.audioMessage` field `26`, `ptt: false`), and relays the sticker to WhatsApp.
