import pino from 'pino'
import { config } from '../config.js'

export function maskJid(jid) {
  if (!jid || typeof jid !== 'string') return '[unknown]'
  const [user, domain] = jid.split('@')
  if (!user) return '[unknown]'
  const visible = user.length > 4 ? `${user.slice(0, 2)}***${user.slice(-2)}` : '***'
  return domain ? `${visible}@${domain}` : visible
}

export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      '*.mediaKey',
      'mediaKey',
      '*.creds',
      'creds',
      '*.noiseKey',
      '*.signedIdentityKey',
      '*.signedPreKey',
      '*.advSecretKey'
    ],
    censor: '[REDACTED]'
  }
})

export const baileysLogger = pino({
  level: process.env.BAILEYS_LOG_LEVEL || 'silent'
})
