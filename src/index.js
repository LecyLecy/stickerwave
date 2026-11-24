import { spawn } from 'node:child_process'
import { config } from './config.js'
import { connectWhatsApp } from './connection.js'
import { createDesktopServer } from './server.js'

function openInBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.env.NO_OPEN === 'true') return
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
    }
  } catch {
    // Ignore auto-open failure; user can open the URL printed in terminal.
  }
}

async function main() {
  let desktop = null
  let whatsapp = null

  const waProxy = {
    getSocket: () => whatsapp?.getSocket?.() || null,
    getSelfJid: () => whatsapp?.getSelfJid?.() || null,
    getStatus: () =>
      whatsapp?.getStatus?.() || {
        state: 'connecting',
        connected: false,
        selfJidMasked: null,
        qrDataUrl: null,
        pairingCode: null,
        error: null
      },
    requestPairingCode: (phone) => {
      if (!whatsapp?.requestPairingCode) {
        throw new Error('Koneksi WhatsApp masih memuat, coba sebentar lagi.')
      }
      return whatsapp.requestPairingCode(phone)
    },
    logout: () => {
      if (!whatsapp?.logout) {
        throw new Error('Koneksi WhatsApp belum siap.')
      }
      return whatsapp.logout()
    }
  }

  desktop = createDesktopServer({ whatsapp: waProxy, config })

  const url = `http://${config.host}:${config.port}`

  await new Promise((resolve, reject) => {
    desktop.server.once('error', reject)
    desktop.server.listen(config.port, config.host, () => {
      resolve()
    })
  })

  console.log('\n======================================================')
  console.log('  Stickerwave — WhatsApp Audio Sticker Studio')
  console.log(`  Buka di browser: ${url}`)
  console.log(`  Author default : ${config.stickerAuthor}`)
  console.log(`  Maks durasi    : ${config.maxDurationSeconds} detik`)
  console.log('======================================================\n')

  openInBrowser(url)

  whatsapp = await connectWhatsApp({
    onStatusChange: () => {
      desktop.broadcastStatus()
    }
  })

  desktop.broadcastStatus()

  const shutdown = () => {
    console.log('\nMenutup Stickerwave...')
    desktop.closeSseClients()
    desktop.server.close()
    whatsapp?.close?.()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((err) => {
  console.error('[FATAL] Gagal menjalankan Stickerwave:', err.message)
  process.exit(1)
})
