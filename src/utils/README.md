# `src/utils/`

Shared helper utilities for safe file lifecycle and privacy-preserving logs.

## Files

- `cleanup.js` — Creates isolated per-job folders inside `temp/`, guarantees cleanup on both success and failure (`withJobTempDir`), and provides `JobQueue` to limit concurrent FFmpeg jobs.
- `logger.js` — Configured Pino logger that automatically redacts sensitive WhatsApp credentials, media keys, and masks phone numbers/JIDs.
