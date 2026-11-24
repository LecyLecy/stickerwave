import fs from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { proto } from '@whiskeysockets/baileys'
import { config as defaultConfig } from './config.js'
import { patchAudioStickerProto } from './proto/audio-sticker-proto.js'
import {
  DEFAULT_VERIFIED_VARIANT,
  sendNativeAudioSticker,
  sendNormalSticker,
  verifyEncodedAudioSticker
} from './services/audio-sticker-sender.js'
import {
  convertToStickerAudio,
  convertVisualToSticker,
  inspectMediaFile,
  MediaError,
  normalizeCropMode
} from './services/media-converter.js'
import { withJobTempDir } from './utils/cleanup.js'
import { logger } from './utils/logger.js'

patchAudioStickerProto()

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readRequestBuffer(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    let aborted = false

    req.on('data', (chunk) => {
      if (aborted) return
      total += chunk.length
      if (total > maxBytes) {
        aborted = true
        reject(
          new MediaError(
            'PAYLOAD_TOO_LARGE',
            `Ukuran unggahan melebihi batas maksimal (${Math.round(maxBytes / (1024 * 1024))} MB).`
          )
        )
        req.resume()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks))
    })

    req.on('error', (err) => {
      if (!aborted) reject(err)
    })
  })
}

function parseOptionalNumber(raw, fallback = null) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return fallback
  const num = Number(raw)
  return Number.isFinite(num) ? num : fallback
}

function sanitizeExtension(filename, fallbackExt = '.bin') {
  const ext = path.extname(String(filename || '')).toLowerCase()
  if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext
  return fallbackExt
}

async function writeUploadedFile(fileObj, destPath) {
  const arrBuf = await fileObj.arrayBuffer()
  const buf = Buffer.from(arrBuf)
  if (buf.length === 0) {
    throw new MediaError('EMPTY_FILE', 'File yang diunggah kosong.')
  }
  await fs.writeFile(destPath, buf)
  return buf.length
}

async function serveStaticFile(reqPath, res, publicDir) {
  const cleanPath = reqPath === '/' ? '/index.html' : reqPath
  const resolved = path.resolve(publicDir, `.${cleanPath}`)
  const rootWithSep = publicDir.endsWith(path.sep) ? publicDir : `${publicDir}${path.sep}`

  if (resolved !== publicDir && !resolved.startsWith(rootWithSep)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) {
      res.writeHead(404)
      res.end('Not Found')
      return
    }
    const ext = path.extname(resolved).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const data = await fs.readFile(resolved)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store'
    })
    res.end(data)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
}

export function createDesktopServer({
  whatsapp = null,
  config = defaultConfig
} = {}) {
  const sseClients = new Set()

  function buildStatusPayload() {
    const waStatus = whatsapp?.getStatus
      ? whatsapp.getStatus()
      : {
          state: 'disconnected',
          connected: false,
          selfJidMasked: null,
          qrDataUrl: null,
          pairingCode: null,
          error: null
        }

    return {
      ...waStatus,
      maxDurationSeconds: config.maxDurationSeconds,
      maxInputSizeMb: config.maxInputSizeMb,
      defaultAuthor: config.stickerAuthor || 'Adin'
    }
  }

  function broadcastStatus() {
    const data = `data: ${JSON.stringify(buildStatusPayload())}\n\n`
    for (const client of sseClients) {
      try {
        client.write(data)
      } catch {
        sseClients.delete(client)
      }
    }
  }

  async function handlePair(req, res) {
    try {
      const raw = await readRequestBuffer(req, 64 * 1024)
      const body = JSON.parse(raw.toString('utf8') || '{}')
      if (!whatsapp?.requestPairingCode) {
        sendJson(res, 503, { ok: false, error: 'Layanan WhatsApp belum siap.' })
        return
      }
      const code = await whatsapp.requestPairingCode(body.phone)
      sendJson(res, 200, { ok: true, pairingCode: code })
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message || 'Gagal meminta kode pairing.' })
    }
  }

  async function handleLogout(_req, res) {
    try {
      if (!whatsapp?.logout) {
        sendJson(res, 503, { ok: false, error: 'Layanan WhatsApp belum siap.' })
        return
      }
      await whatsapp.logout()
      broadcastStatus()
      sendJson(res, 200, { ok: true })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: err.message || 'Gagal memutuskan koneksi WhatsApp.' })
    }
  }

  async function handleSendSticker(req, res) {
    const contentType = req.headers['content-type'] || ''
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      sendJson(res, 400, { ok: false, error: 'Format request harus multipart/form-data.' })
      return
    }

    const maxBodyBytes = Math.round((config.maxInputSizeMb * 2 + 4) * 1024 * 1024)
    let formData
    try {
      const rawBody = await readRequestBuffer(req, maxBodyBytes)
      formData = await new Response(rawBody, {
        headers: { 'content-type': contentType }
      }).formData()
    } catch (err) {
      const status = err instanceof MediaError && err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
      sendJson(res, status, { ok: false, error: err.userMessage || err.message || 'Gagal membaca data unggahan.' })
      return
    }

    const stickerName = String(formData.get('stickerName') || '').trim()
    if (!stickerName) {
      sendJson(res, 400, { ok: false, error: 'Nama stiker wajib diisi sebelum mengirim.' })
      return
    }
    if (stickerName.length > 80) {
      sendJson(res, 400, { ok: false, error: 'Nama stiker maksimal 80 karakter.' })
      return
    }

    const visualFile = formData.get('visual')
    if (!visualFile || typeof visualFile.arrayBuffer !== 'function' || visualFile.size === 0) {
      sendJson(res, 400, { ok: false, error: 'Pilih 1 gambar atau 1 video terlebih dahulu.' })
      return
    }

    const rawAudio = formData.get('audio')
    const hasCustomAudio = Boolean(rawAudio && typeof rawAudio.arrayBuffer === 'function' && rawAudio.size > 0)

    const dryRun = String(formData.get('dryRun') || '').toLowerCase() === 'true'
    const sock = whatsapp?.getSocket ? whatsapp.getSocket() : null
    const selfJid = whatsapp?.getSelfJid ? whatsapp.getSelfJid() : null

    if (!dryRun && (!sock || !selfJid || !whatsapp?.getStatus?.()?.connected)) {
      sendJson(res, 503, {
        ok: false,
        error: 'WhatsApp belum terhubung. Scan QR atau tunggu status terhubung terlebih dahulu.'
      })
      return
    }

    const cropMode = normalizeCropMode(formData.get('cropMode'), 'center')
    const cropX = parseOptionalNumber(formData.get('cropX'), null)
    const cropY = parseOptionalNumber(formData.get('cropY'), null)
    const fps = parseOptionalNumber(formData.get('fps'), 12)
    const quality = parseOptionalNumber(formData.get('quality'), 65)
    const visualStart = Math.max(0, parseOptionalNumber(formData.get('visualStart'), 0))
    const visualEnd = parseOptionalNumber(formData.get('visualEnd'), null)
    const audioStart = Math.max(0, parseOptionalNumber(formData.get('audioStart'), 0))
    const audioEnd = parseOptionalNumber(formData.get('audioEnd'), null)
    const author = config.stickerAuthor || 'Adin'

    try {
      const result = await withJobTempDir(async (jobDir) => {
        const visualExt = sanitizeExtension(visualFile.name, '.media')
        const visualPath = path.join(jobDir, `visual${visualExt}`)
        await writeUploadedFile(visualFile, visualPath)

        const visualProbe = await inspectMediaFile(visualPath, { maxInputSizeMb: config.maxInputSizeMb })
        if (!visualProbe.hasVideo) {
          throw new MediaError('NO_VISUAL_STREAM', 'File visual harus berupa gambar atau video.')
        }

        let customAudioPath = null
        let customAudioProbe = null
        if (hasCustomAudio) {
          const audioExt = sanitizeExtension(rawAudio.name, '.audio')
          customAudioPath = path.join(jobDir, `custom-audio${audioExt}`)
          await writeUploadedFile(rawAudio, customAudioPath)
          customAudioProbe = await inspectMediaFile(customAudioPath, { maxInputSizeMb: config.maxInputSizeMb })
          if (!customAudioProbe.hasAudio) {
            throw new MediaError('NO_AUDIO_STREAM', 'File audio yang dipilih tidak memiliki track suara.')
          }
        }

        const stickerOut = path.join(jobDir, 'sticker.webp')
        const audioOut = path.join(jobDir, 'audio.ogg')

        let stickerResult
        let audioResult = null
        let audioSource = 'none'
        let targetDuration = 0

        if (visualProbe.isAnimated) {
          const totalVideoDur = visualProbe.durationSeconds > 0 ? visualProbe.durationSeconds : config.maxDurationSeconds
          if (visualStart >= totalVideoDur - 0.1) {
            throw new MediaError('INVALID_VIDEO_RANGE', 'Titik awal video melebihi durasi video.')
          }

          const effectiveEnd = visualEnd !== null
            ? Math.min(totalVideoDur, visualEnd)
            : Math.min(totalVideoDur, visualStart + config.maxDurationSeconds)

          const requestedDuration = effectiveEnd - visualStart
          if (requestedDuration < 0.3) {
            throw new MediaError('CLIP_TOO_SHORT', 'Durasi potongan video minimal 0.3 detik.')
          }
          if (requestedDuration > config.maxDurationSeconds + 0.05) {
            throw new MediaError(
              'CLIP_TOO_LONG',
              `Durasi maksimal stiker adalah ${config.maxDurationSeconds} detik agar tidak error di WhatsApp.`
            )
          }

          const willHaveAudio = hasCustomAudio || visualProbe.hasAudio
          stickerResult = await convertVisualToSticker(visualPath, stickerOut, {
            start: visualStart,
            duration: requestedDuration,
            fps,
            quality,
            crop: cropMode,
            cropX,
            cropY,
            packName: stickerName,
            author,
            emojis: willHaveAudio ? ['🔊'] : ['✨'],
            maxInputSizeMb: config.maxInputSizeMb
          })

          targetDuration = stickerResult.durationSeconds || requestedDuration

          if (hasCustomAudio) {
            // Custom audio strictly overrides (mutes) original video audio and matches video clip duration
            audioResult = await convertToStickerAudio(customAudioPath, audioOut, {
              start: audioStart,
              duration: targetDuration,
              maxDurationSeconds: config.maxDurationSeconds,
              maxInputSizeMb: config.maxInputSizeMb
            })
            audioSource = 'custom'
          } else if (visualProbe.hasAudio) {
            audioResult = await convertToStickerAudio(visualPath, audioOut, {
              start: visualStart,
              duration: targetDuration,
              maxDurationSeconds: config.maxDurationSeconds,
              maxInputSizeMb: config.maxInputSizeMb
            })
            audioSource = 'original'
          }
        } else {
          // Static image visual
          stickerResult = await convertVisualToSticker(visualPath, stickerOut, {
            crop: cropMode,
            cropX,
            cropY,
            packName: stickerName,
            author,
            emojis: hasCustomAudio ? ['🔊'] : ['✨'],
            maxInputSizeMb: config.maxInputSizeMb
          })

          if (hasCustomAudio) {
            const totalAudioDur = customAudioProbe.durationSeconds > 0 ? customAudioProbe.durationSeconds : config.maxDurationSeconds
            const effectiveAudioEnd = audioEnd !== null
              ? Math.min(totalAudioDur, audioEnd)
              : Math.min(totalAudioDur, audioStart + config.maxDurationSeconds)
            const requestedAudioDur = effectiveAudioEnd - audioStart

            if (requestedAudioDur < 0.3) {
              throw new MediaError('AUDIO_TOO_SHORT', 'Durasi potongan audio minimal 0.3 detik.')
            }
            if (requestedAudioDur > config.maxDurationSeconds + 0.05) {
              throw new MediaError(
                'AUDIO_TOO_LONG',
                `Durasi maksimal audio adalah ${config.maxDurationSeconds} detik.`
              )
            }

            audioResult = await convertToStickerAudio(customAudioPath, audioOut, {
              start: audioStart,
              duration: requestedAudioDur,
              maxDurationSeconds: config.maxDurationSeconds,
              maxInputSizeMb: config.maxInputSizeMb
            })
            targetDuration = audioResult.durationSeconds
            audioSource = 'custom'
          }
        }

        const hasAudio = Boolean(audioResult)

        if (dryRun) {
          let protoVerified = false
          if (hasAudio) {
            const testMsg = proto.Message.fromObject({
              stickerMessage: {
                url: 'https://mmg.whatsapp.net/dryrun-sticker',
                mimetype: 'image/webp',
                fileLength: stickerResult.sizeBytes,
                width: stickerResult.width,
                height: stickerResult.height,
                isAnimated: stickerResult.isAnimated,
                emojis: '🔊',
                audioMessage: {
                  url: 'https://mmg.whatsapp.net/dryrun-audio',
                  mimetype: audioResult.mimetype,
                  fileLength: audioResult.sizeBytes,
                  seconds: audioResult.seconds,
                  ptt: false
                }
              }
            })
            const verify = verifyEncodedAudioSticker(testMsg)
            protoVerified = Boolean(verify.hasField26)
          }

          return {
            ok: true,
            dryRun: true,
            messageId: 'dry-run',
            stickerName,
            author,
            isAnimated: stickerResult.isAnimated,
            hasAudio,
            audioSource,
            stickerBytes: stickerResult.sizeBytes,
            audioBytes: audioResult?.sizeBytes || 0,
            videoDurationSeconds: stickerResult.isAnimated ? Number(targetDuration.toFixed(2)) : 0,
            audioDurationSeconds: audioResult ? Number(audioResult.durationSeconds.toFixed(2)) : 0,
            cropMode: stickerResult.cropMode,
            exifContainsPackName: stickerResult.buffer.includes(Buffer.from(stickerName, 'utf8')),
            exifContainsAuthor: stickerResult.buffer.includes(Buffer.from(author, 'utf8')),
            protoVerified
          }
        }

        let sendResult
        if (hasAudio) {
          sendResult = await sendNativeAudioSticker(sock, selfJid, {
            stickerBuffer: stickerResult.buffer,
            audioBuffer: audioResult.buffer,
            isAnimated: stickerResult.isAnimated,
            width: stickerResult.width,
            height: stickerResult.height,
            seconds: audioResult.seconds,
            variant: DEFAULT_VERIFIED_VARIANT
          })
        } else {
          sendResult = await sendNormalSticker(sock, selfJid, {
            stickerBuffer: stickerResult.buffer,
            isAnimated: stickerResult.isAnimated,
            width: stickerResult.width,
            height: stickerResult.height
          })
        }

        logger.info(
          {
            messageId: sendResult.messageId,
            isAnimated: stickerResult.isAnimated,
            hasAudio,
            audioSource,
            stickerBytes: stickerResult.sizeBytes,
            audioBytes: audioResult?.sizeBytes || 0
          },
          'Stiker berhasil dikirim ke chat pribadi dari Desktop Studio'
        )

        return {
          ok: true,
          messageId: sendResult.messageId,
          stickerName,
          author,
          isAnimated: stickerResult.isAnimated,
          hasAudio,
          audioSource,
          stickerBytes: stickerResult.sizeBytes,
          audioBytes: audioResult?.sizeBytes || 0,
          durationSeconds: Number((audioResult?.durationSeconds || targetDuration || 0).toFixed(2))
        }
      }, 'studio', config.tempDir)

      sendJson(res, 200, result)
    } catch (err) {
      if (err instanceof MediaError) {
        sendJson(res, 400, { ok: false, code: err.code, error: err.userMessage })
        return
      }
      logger.error({ err: err.message }, 'Gagal memproses atau mengirim stiker dari Desktop Studio')
      sendJson(res, 500, { ok: false, error: err.message || 'Terjadi kesalahan saat memproses stiker.' })
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`)
      const pathname = decodeURIComponent(urlObj.pathname)

      if (req.method === 'GET' && pathname === '/api/status') {
        sendJson(res, 200, buildStatusPayload())
        return
      }

      if (req.method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive'
        })
        res.write(`data: ${JSON.stringify(buildStatusPayload())}\n\n`)
        sseClients.add(res)
        req.on('close', () => {
          sseClients.delete(res)
        })
        return
      }

      if (req.method === 'POST' && pathname === '/api/pair') {
        await handlePair(req, res)
        return
      }

      if (req.method === 'POST' && pathname === '/api/logout') {
        await handleLogout(req, res)
        return
      }

      if (req.method === 'POST' && pathname === '/api/send-sticker') {
        await handleSendSticker(req, res)
        return
      }

      if (req.method === 'GET') {
        await serveStaticFile(pathname, res, config.publicDir)
        return
      }

      sendJson(res, 405, { ok: false, error: 'Method tidak didukung.' })
    } catch (err) {
      logger.error({ err: err.message }, 'Unhandled HTTP error')
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: 'Terjadi kesalahan server internal.' })
      }
    }
  })

  return {
    server,
    broadcastStatus,
    closeSseClients() {
      for (const client of sseClients) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
      sseClients.clear()
    }
  }
}
