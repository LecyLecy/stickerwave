import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { config as baseConfig } from '../src/config.js'
import { createDesktopServer } from '../src/server.js'

const execFileAsync = promisify(execFile)

async function runFfmpeg(args) {
  await execFileAsync(baseConfig.ffmpegPath, args, { timeout: 25000, windowsHide: true })
}

let workDir
let tempDir
let desktop
let baseUrl
let mockWaConnected = true
let logoutCount = 0
const relayedMessages = []

const mockWhatsapp = {
  getStatus: () => ({
    state: mockWaConnected ? 'connected' : 'qr',
    connected: mockWaConnected,
    selfJidMasked: mockWaConnected ? '6281***890@s.whatsapp.net' : null,
    qrDataUrl: mockWaConnected ? null : 'data:image/png;base64,MOCK_QR',
    pairingCode: null,
    error: null
  }),
  getSelfJid: () => (mockWaConnected ? '6281234567890@s.whatsapp.net' : null),
  getSocket: () =>
    mockWaConnected
      ? {
          user: { id: '6281234567890:1@s.whatsapp.net' },
          waUploadToServer: async () => ({
            mediaUrl: 'https://mmg.whatsapp.net/mock-upload',
            directPath: '/v/t62.15575-24/mock'
          }),
          relayMessage: async (jid, message, options) => {
            relayedMessages.push({ jid, message, options })
            return options?.messageId || 'MOCK_MSG_ID'
          }
        }
      : null,
  requestPairingCode: async (phone) => `1234-${String(phone).slice(-4)}`,
  logout: async () => {
    logoutCount += 1
    mockWaConnected = false
    return true
  }
}

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-desktop-studio-test-'))
  tempDir = path.join(workDir, 'temp')
  await fs.mkdir(tempDir, { recursive: true })

  // 1. Wide PNG image (800x400)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=royalblue:s=800x400:d=1',
    '-frames:v', '1', path.join(workDir, 'photo.png')
  ])

  // 2. 7-second MP4 video WITH original audio (440 Hz)
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=7:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    path.join(workDir, 'video-7s.mp4')
  ])

  // 3. 3-second silent MP4 video (no audio)
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=12',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(workDir, 'video-silent.mp4')
  ])

  // 4. 9-second custom WAV audio (880 Hz)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=9',
    path.join(workDir, 'custom-audio-9s.wav')
  ])

  const testConfig = {
    ...baseConfig,
    tempDir,
    maxDurationSeconds: 5,
    stickerAuthor: 'Adin'
  }

  desktop = createDesktopServer({ whatsapp: mockWhatsapp, config: testConfig })
  await new Promise((resolve) => {
    desktop.server.listen(0, '127.0.0.1', resolve)
  })
  const addr = desktop.server.address()
  baseUrl = `http://127.0.0.1:${addr.port}`
})

test.after(async () => {
  if (desktop) {
    desktop.closeSseClients()
    await new Promise((resolve) => desktop.server.close(resolve))
  }
  if (workDir) {
    await fs.rm(workDir, { recursive: true, force: true })
  }
})

async function fileToBlob(filePath, mimeType) {
  const buf = await fs.readFile(filePath)
  return new Blob([buf], { type: mimeType })
}

test('1. Serves Stickerwave UI with Connect-First QR Gate, logo, logout button, and status endpoint', async () => {
  const htmlResp = await fetch(`${baseUrl}/`)
  assert.equal(htmlResp.status, 200)
  const html = await htmlResp.text()
  assert.match(html, /Stickerwave/)
  assert.match(html, /id="connectGate"/)
  assert.match(html, /class="app-shell hidden" id="studioApp"/)
  assert.match(html, /id="logoutBtn"/)
  assert.match(html, /Kirim ke Chat Pribadi/)

  const logoResp = await fetch(`${baseUrl}/logo.png`)
  assert.equal(logoResp.status, 200)

  const statusResp = await fetch(`${baseUrl}/api/status`)
  assert.equal(statusResp.status, 200)
  const status = await statusResp.json()
  assert.equal(status.connected, true)
  assert.equal(status.defaultAuthor, 'Adin')
  assert.equal(status.maxDurationSeconds, 5)
})

test('2. Rejects empty stickerName, missing visual, non-visual upload, and oversized duration', async () => {
  // Missing stickerName
  const fd1 = new FormData()
  fd1.append('visual', await fileToBlob(path.join(workDir, 'photo.png'), 'image/png'), 'photo.png')
  fd1.append('dryRun', 'true')
  const r1 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd1 })
  assert.equal(r1.status, 400)
  const j1 = await r1.json()
  assert.match(j1.error, /Nama stiker wajib/i)

  // Missing visual
  const fd2 = new FormData()
  fd2.append('stickerName', 'Test Kosong')
  fd2.append('dryRun', 'true')
  const r2 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd2 })
  assert.equal(r2.status, 400)

  // Audio accidentally uploaded as visual
  const fd3 = new FormData()
  fd3.append('stickerName', 'Salah Input')
  fd3.append('visual', await fileToBlob(path.join(workDir, 'custom-audio-9s.wav'), 'audio/wav'), 'sound.wav')
  fd3.append('dryRun', 'true')
  const r3 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd3 })
  assert.equal(r3.status, 400)

  // Video duration > maxDurationSeconds (5s): 0s..6.5s = 6.5s
  const fd4 = new FormData()
  fd4.append('stickerName', 'Kepanjangan')
  fd4.append('visual', await fileToBlob(path.join(workDir, 'video-7s.mp4'), 'video/mp4'), 'video-7s.mp4')
  fd4.append('visualStart', '0')
  fd4.append('visualEnd', '6.5')
  fd4.append('dryRun', 'true')
  const r4 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd4 })
  assert.equal(r4.status, 400)
  const j4 = await r4.json()
  assert.equal(j4.code, 'CLIP_TOO_LONG')
})

test('3. Video 2s..5s (3s) + custom audio start 3s -> overrides video audio with synced 3s audio (3s..6s) + EXIF Adin + Protobuf field 26', async () => {
  const fd = new FormData()
  fd.append('stickerName', 'Ngakak Sync')
  fd.append('visual', await fileToBlob(path.join(workDir, 'video-7s.mp4'), 'video/mp4'), 'video-7s.mp4')
  fd.append('audio', await fileToBlob(path.join(workDir, 'custom-audio-9s.wav'), 'audio/wav'), 'custom.wav')
  fd.append('visualStart', '2')
  fd.append('visualEnd', '5')
  fd.append('audioStart', '3')
  fd.append('cropMode', 'custom')
  fd.append('cropX', '0.25')
  fd.append('cropY', '0.75')
  fd.append('dryRun', 'true')

  const resp = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd })
  assert.equal(resp.status, 200)
  const data = await resp.json()

  assert.equal(data.ok, true)
  assert.equal(data.isAnimated, true)
  assert.equal(data.hasAudio, true)
  assert.equal(data.audioSource, 'custom')
  assert.equal(data.stickerName, 'Ngakak Sync')
  assert.equal(data.author, 'Adin')
  assert.equal(data.exifContainsPackName, true)
  assert.equal(data.exifContainsAuthor, true)
  assert.equal(data.protoVerified, true)
  assert.ok(data.videoDurationSeconds >= 2.8 && data.videoDurationSeconds <= 3.2, `Expected ~3s video, got ${data.videoDurationSeconds}`)
  assert.ok(data.audioDurationSeconds >= 2.7 && data.audioDurationSeconds <= 3.3, `Expected ~3s custom audio (3s..6s), got ${data.audioDurationSeconds}`)
})

test('4. Video 1s..4s without custom audio uses original video audio; silent video produces silent animated sticker', async () => {
  // Video with original audio
  const fd1 = new FormData()
  fd1.append('stickerName', 'Audio Asli')
  fd1.append('visual', await fileToBlob(path.join(workDir, 'video-7s.mp4'), 'video/mp4'), 'video-7s.mp4')
  fd1.append('visualStart', '1')
  fd1.append('visualEnd', '4')
  fd1.append('dryRun', 'true')

  const r1 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd1 })
  assert.equal(r1.status, 200)
  const d1 = await r1.json()
  assert.equal(d1.hasAudio, true)
  assert.equal(d1.audioSource, 'original')
  assert.equal(d1.protoVerified, true)
  assert.ok(d1.audioDurationSeconds >= 2.7 && d1.audioDurationSeconds <= 3.3)

  // Silent video without custom audio
  const fd2 = new FormData()
  fd2.append('stickerName', 'Tanpa Suara')
  fd2.append('visual', await fileToBlob(path.join(workDir, 'video-silent.mp4'), 'video/mp4'), 'video-silent.mp4')
  fd2.append('visualStart', '0')
  fd2.append('visualEnd', '2')
  fd2.append('dryRun', 'true')

  const r2 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd2 })
  assert.equal(r2.status, 200)
  const d2 = await r2.json()
  assert.equal(d2.isAnimated, true)
  assert.equal(d2.hasAudio, false)
  assert.equal(d2.audioSource, 'none')
  assert.equal(d2.exifContainsPackName, true)
  assert.equal(d2.exifContainsAuthor, true)
})

test('5. Static image + custom audio and static image without audio both succeed with EXIF Adin', async () => {
  // Image + custom audio (1s..4s)
  const fd1 = new FormData()
  fd1.append('stickerName', 'Foto Bersuara')
  fd1.append('visual', await fileToBlob(path.join(workDir, 'photo.png'), 'image/png'), 'photo.png')
  fd1.append('audio', await fileToBlob(path.join(workDir, 'custom-audio-9s.wav'), 'audio/wav'), 'custom.wav')
  fd1.append('audioStart', '1')
  fd1.append('audioEnd', '4')
  fd1.append('dryRun', 'true')

  const r1 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd1 })
  assert.equal(r1.status, 200)
  const d1 = await r1.json()
  assert.equal(d1.isAnimated, false)
  assert.equal(d1.hasAudio, true)
  assert.equal(d1.audioSource, 'custom')
  assert.equal(d1.protoVerified, true)
  assert.ok(d1.audioDurationSeconds >= 2.7 && d1.audioDurationSeconds <= 3.3)

  // Image without audio
  const fd2 = new FormData()
  fd2.append('stickerName', 'Foto Polos')
  fd2.append('visual', await fileToBlob(path.join(workDir, 'photo.png'), 'image/png'), 'photo.png')
  fd2.append('cropMode', 'none')
  fd2.append('dryRun', 'true')

  const r2 = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd2 })
  assert.equal(r2.status, 200)
  const d2 = await r2.json()
  assert.equal(d2.isAnimated, false)
  assert.equal(d2.hasAudio, false)
  assert.equal(d2.cropMode, 'none')
  assert.equal(d2.exifContainsPackName, true)
  assert.equal(d2.exifContainsAuthor, true)
})

test('6. Live send relays native audio sticker directly to personal self-chat and cleans up all temp files', async () => {
  relayedMessages.length = 0

  const fd = new FormData()
  fd.append('stickerName', 'Kirim Pribadi')
  fd.append('visual', await fileToBlob(path.join(workDir, 'photo.png'), 'image/png'), 'photo.png')
  fd.append('audio', await fileToBlob(path.join(workDir, 'custom-audio-9s.wav'), 'audio/wav'), 'custom.wav')
  fd.append('audioStart', '2')
  fd.append('audioEnd', '4')

  const resp = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fd })
  assert.equal(resp.status, 200)
  const data = await resp.json()
  assert.equal(data.ok, true)
  assert.equal(data.author, 'Adin')
  assert.equal(relayedMessages.length, 1)
  assert.equal(relayedMessages[0].jid, '6281234567890@s.whatsapp.net')
  assert.ok(relayedMessages[0].message.stickerMessage?.audioMessage, 'Nested audioMessage must be present in relayed message')

  // Verify disconnected state returns 503
  mockWaConnected = false
  const fdOff = new FormData()
  fdOff.append('stickerName', 'Saat Offline')
  fdOff.append('visual', await fileToBlob(path.join(workDir, 'photo.png'), 'image/png'), 'photo.png')
  const rOff = await fetch(`${baseUrl}/api/send-sticker`, { method: 'POST', body: fdOff })
  assert.equal(rOff.status, 503)
  mockWaConnected = true

  // Verify tempDir has zero leftover studio-* directories
  const remainingTemp = await fs.readdir(tempDir)
  assert.deepEqual(remainingTemp, [], `Temp directory should be completely clean, found: ${remainingTemp.join(', ')}`)
})

test('7. POST /api/logout unlinks WhatsApp session and returns to QR connect state', async () => {
  mockWaConnected = true
  logoutCount = 0

  const resp = await fetch(`${baseUrl}/api/logout`, { method: 'POST' })
  assert.equal(resp.status, 200)
  const data = await resp.json()
  assert.equal(data.ok, true)
  assert.equal(logoutCount, 1)

  const statusResp = await fetch(`${baseUrl}/api/status`)
  const status = await statusResp.json()
  assert.equal(status.connected, false)
  assert.equal(status.state, 'qr')
  assert.ok(status.qrDataUrl, 'QR code data URL should be exposed after logout')

  mockWaConnected = true
})
