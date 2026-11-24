import dotenv from 'dotenv'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ffmpegStatic from 'ffmpeg-static'
import ffprobeStatic from 'ffprobe-static'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
export const PROJECT_ROOT = path.resolve(__dirname, '..')

function parsePositiveNumber(value, defaultValue, name) {
  if (value === undefined || value === '') return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Konfigurasi ${name} harus berupa angka positif, diterima: ${value}`)
  }
  return parsed
}

export function loadConfig(env = process.env) {
  const ffmpegPath = (env.FFMPEG_PATH || '').trim() || ffmpegStatic || 'ffmpeg'
  const ffprobePath = (env.FFPROBE_PATH || '').trim() || ffprobeStatic?.path || 'ffprobe'

  return {
    host: (env.HOST || '127.0.0.1').trim(),
    port: parsePositiveNumber(env.PORT, 3456, 'PORT'),
    maxDurationSeconds: parsePositiveNumber(env.MAX_DURATION_SECONDS, 10, 'MAX_DURATION_SECONDS'),
    maxInputSizeMb: parsePositiveNumber(env.MAX_INPUT_SIZE_MB, 20, 'MAX_INPUT_SIZE_MB'),
    maxConcurrentJobs: parsePositiveNumber(env.MAX_CONCURRENT_JOBS, 2, 'MAX_CONCURRENT_JOBS'),
    processingTimeoutMs: parsePositiveNumber(env.PROCESSING_TIMEOUT_MS, 45000, 'PROCESSING_TIMEOUT_MS'),
    stickerPackName: (env.STICKER_PACK_NAME || 'Audio Sticker').trim(),
    stickerAuthor: (env.STICKER_AUTHOR || 'Adin').trim(),
    stickerCropMode: (env.STICKER_CROP_MODE || 'center').trim().toLowerCase(),
    logLevel: (env.LOG_LEVEL || 'info').trim(),
    ffmpegPath,
    ffprobePath,
    authDir: path.join(PROJECT_ROOT, 'auth'),
    tempDir: path.join(PROJECT_ROOT, 'temp'),
    publicDir: path.join(PROJECT_ROOT, 'public')
  }
}

export const config = loadConfig()
