import fs from 'node:fs/promises'
import QRCode from 'qrcode'
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState
} from '@whiskeysockets/baileys'
import { config } from './config.js'
import { patchAudioStickerProto } from './proto/audio-sticker-proto.js'
import { baileysLogger, logger, maskJid } from './utils/logger.js'

patchAudioStickerProto()

export function normalizeTargetJid(phoneOrJid, selfUserId) {
  if (phoneOrJid) {
    const trimmed = String(phoneOrJid).trim()
    if (trimmed.includes('@')) return jidNormalizedUser(trimmed)
    const digits = trimmed.replace(/[^\d]/g, '')
    if (!digits) {
      throw new Error(`Nomor tujuan tidak valid: ${phoneOrJid}`)
    }
    return `${digits}@s.whatsapp.net`
  }
  if (selfUserId) {
    return jidNormalizedUser(selfUserId)
  }
  throw new Error('Nomor tujuan tidak ditentukan dan akun belum terhubung.')
}

export async function connectWhatsApp({
  authDir = config.authDir,
  maxReconnectAttempts = 8,
  onStatusChange = null,
  onOpen = null,
  onLoggedOut = null
} = {}) {
  await fs.mkdir(authDir, { recursive: true })
  let authSession = await useMultiFileAuthState(authDir)

  let version
  try {
    const latest = await fetchLatestBaileysVersion()
    version = latest.version
    logger.info({ version: version.join('.'), isLatest: latest.isLatest }, 'Menggunakan versi WhatsApp Web terbaru')
  } catch (err) {
    logger.warn({ err: err.message }, 'Gagal mengambil versi terbaru WA Web, menggunakan versi bawaan Baileys')
  }

  let reconnectAttempts = 0
  let closedManually = false
  let resettingSession = false
  let currentSock = null
  let reconnectTimer = null

  const status = {
    state: 'connecting', // connecting | qr | connected | disconnected | logged_out | error
    connected: false,
    selfJid: null,
    selfJidMasked: null,
    qrDataUrl: null,
    pairingCode: null,
    error: null
  }

  function emitStatus() {
    if (typeof onStatusChange === 'function') {
      onStatusChange(getPublicStatus())
    }
  }

  function getPublicStatus() {
    return {
      state: status.state,
      connected: status.connected,
      selfJidMasked: status.selfJidMasked,
      qrDataUrl: status.qrDataUrl,
      pairingCode: status.pairingCode,
      error: status.error
    }
  }

  async function resetAuthAndRestart(reasonMessage = null) {
    if (resettingSession || closedManually) return
    resettingSession = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const prevSock = currentSock
    currentSock = null

    try {
      prevSock?.ws?.close()
    } catch {
      // ignore close errors
    }

    status.state = 'connecting'
    status.connected = false
    status.selfJid = null
    status.selfJidMasked = null
    status.qrDataUrl = null
    status.pairingCode = null
    status.error = reasonMessage
    emitStatus()

    await fs.rm(authDir, { recursive: true, force: true })
    await fs.mkdir(authDir, { recursive: true })
    authSession = await useMultiFileAuthState(authDir)
    reconnectAttempts = 0
    resettingSession = false

    if (!closedManually) {
      await startSocket()
    }
  }

  async function startSocket() {
    status.state = 'connecting'
    status.connected = false
    emitStatus()

    const sock = makeWASocket({
      auth: authSession.state,
      version,
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: false
    })

    currentSock = sock
    sock.ev.on('creds.update', async () => {
      if (resettingSession) return
      await authSession.saveCreds()
    })

    sock.ev.on('connection.update', async (update) => {
      if (sock !== currentSock) return
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        try {
          const dataUrl = await QRCode.toDataURL(qr, {
            width: 340,
            margin: 3,
            color: {
              dark: '#000000',
              light: '#FFFFFF'
            }
          })
          status.state = 'qr'
          status.connected = false
          status.qrDataUrl = dataUrl
          status.error = null
          emitStatus()
        } catch (err) {
          logger.error({ err: err.message }, 'Gagal membuat gambar QR untuk UI')
        }
      }

      if (connection === 'open') {
        reconnectAttempts = 0
        const selfJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null
        status.state = 'connected'
        status.connected = true
        status.selfJid = selfJid
        status.selfJidMasked = maskJid(selfJid)
        status.qrDataUrl = null
        status.pairingCode = null
        status.error = null
        emitStatus()
        console.log(`[OK] Terhubung ke WhatsApp (${status.selfJidMasked}).`)
        if (onOpen) {
          await onOpen(sock, selfJid)
        }
      }

      if (connection === 'close') {
        if (closedManually || resettingSession) return

        const statusCode = lastDisconnect?.error?.output?.statusCode
        const isLoggedOut = statusCode === DisconnectReason.loggedOut

        status.connected = false
        status.selfJid = null

        if (isLoggedOut) {
          console.warn('[!] Sesi WhatsApp terputus/keluar. Menyiapkan QR baru untuk login ulang...')
          if (onLoggedOut) onLoggedOut(statusCode)
          await resetAuthAndRestart('Sesi WhatsApp telah keluar. Silakan scan QR baru untuk terhubung kembali.')
          return
        }

        if (reconnectAttempts >= maxReconnectAttempts) {
          status.state = 'error'
          status.error = `Gagal menyambung ulang ke WhatsApp (kode ${statusCode || 'unknown'}).`
          emitStatus()
          console.error(`[!] Gagal tersambung kembali setelah ${maxReconnectAttempts} percobaan (status=${statusCode}).`)
          return
        }

        reconnectAttempts += 1
        const delayMs = Math.min(2000 * reconnectAttempts, 10000)
        status.state = 'disconnected'
        status.error = `Koneksi terputus. Menyambung ulang (${reconnectAttempts}/${maxReconnectAttempts})...`
        emitStatus()
        console.warn(`[!] Koneksi terputus (status=${statusCode}). Menyambung ulang #${reconnectAttempts}...`)
        reconnectTimer = setTimeout(() => {
          if (!closedManually && !resettingSession) startSocket()
        }, delayMs)
      }
    })

    return sock
  }

  await startSocket()

  return {
    getSocket: () => currentSock,
    getSelfJid: () => status.selfJid || (currentSock?.user?.id ? jidNormalizedUser(currentSock.user.id) : null),
    getStatus: getPublicStatus,
    async requestPairingCode(phone) {
      const digits = String(phone || '').replace(/[^\d]/g, '')
      if (digits.length < 9 || digits.length > 16) {
        throw new Error('Masukkan nomor WhatsApp yang valid (contoh: 6281234567890).')
      }
      if (!currentSock) {
        throw new Error('Koneksi WhatsApp belum siap.')
      }
      if (status.connected || authSession.state.creds.registered) {
        throw new Error('Akun WhatsApp sudah terhubung.')
      }
      const rawCode = await currentSock.requestPairingCode(digits)
      const formatted = rawCode?.length === 8 ? `${rawCode.slice(0, 4)}-${rawCode.slice(4)}` : rawCode
      status.pairingCode = formatted
      emitStatus()
      return formatted
    },
    async logout() {
      const sockToLogout = currentSock
      if (sockToLogout && status.connected) {
        try {
          await sockToLogout.logout()
        } catch {
          // Best-effort remote unlink; always clear local session regardless
        }
      }
      console.log('[INFO] Sesi WhatsApp diputuskan. Menyiapkan QR baru...')
      await resetAuthAndRestart('Koneksi WhatsApp telah diputuskan. Scan QR untuk menghubungkan akun kembali.')
      return true
    },
    close: () => {
      closedManually = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try {
        currentSock?.ws?.close()
      } catch {
        // ignore close errors
      }
    }
  }
}
