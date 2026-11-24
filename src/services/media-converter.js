import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { config } from '../config.js'
import { JobQueue } from '../utils/cleanup.js'
import { injectStickerExif, isAnimatedWebp } from './sticker-exif.js'

const execFileAsync = promisify(execFile)

export class MediaError extends Error {
  constructor(code, userMessage, cause = null) {
    super(userMessage)
    this.name = 'MediaError'
    this.code = code
    this.userMessage = userMessage
    if (cause) this.cause = cause
  }
}

const MAX_STATIC_WEBP_BYTES = 100 * 1024 // ~100 KB WhatsApp static sticker guideline
const MAX_ANIMATED_WEBP_BYTES = 490 * 1024 // ~500 KB WhatsApp animated sticker guideline

export const mediaJobQueue = new JobQueue(config.maxConcurrentJobs)

async function runExec(binary, args, timeoutMs = config.processingTimeoutMs) {
  try {
    return await execFileAsync(binary, args, {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    })
  } catch (err) {
    if (err.killed || err.signal === 'SIGTERM') {
      throw new MediaError('TIMEOUT', 'Proses konversi media melebihi batas waktu.', err)
    }
    throw err
  }
}

export async function validateInputSize(filePath, maxInputSizeMb = config.maxInputSizeMb) {
  let stat
  try {
    stat = await fs.stat(filePath)
  } catch (err) {
    throw new MediaError('FILE_NOT_FOUND', 'File media tidak ditemukan.', err)
  }

  if (stat.size === 0) {
    throw new MediaError('EMPTY_FILE', 'File media kosong atau rusak.')
  }

  const maxBytes = maxInputSizeMb * 1024 * 1024
  if (stat.size > maxBytes) {
    throw new MediaError(
      'FILE_TOO_LARGE',
      `Ukuran file terlalu besar (${(stat.size / (1024 * 1024)).toFixed(1)} MB). Maksimal ${maxInputSizeMb} MB.`
    )
  }

  return stat
}

function isWebpHeader(buf) {
  return (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  )
}

/**
 * Inspects actual media streams via FFprobe + WebP header inspection (does not trust file extension).
 */
export async function inspectMediaFile(filePath, { maxInputSizeMb = config.maxInputSizeMb } = {}) {
  const stat = await validateInputSize(filePath, maxInputSizeMb)
  const headBuf = Buffer.alloc(Math.min(stat.size, 64))
  const fh = await fs.open(filePath, 'r')
  try {
    await fh.read(headBuf, 0, headBuf.length, 0)
  } finally {
    await fh.close()
  }

  // Fast-path animated WebP detection (FFprobe 4.x may not decode animated WebP cleanly)
  if (isWebpHeader(headBuf)) {
    const fullBuf = await fs.readFile(filePath)
    const animated = isAnimatedWebp(fullBuf)
    let width = 512
    let height = 512
    try {
      const { stdout } = await runExec(config.ffprobePath, [
        '-v', 'error',
        '-show_format',
        '-show_streams',
        '-of', 'json',
        filePath
      ], 15000)
      const parsed = JSON.parse(stdout)
      const vStream = (parsed.streams || []).find((s) => s.codec_type === 'video')
      if (vStream?.width) width = Number(vStream.width)
      if (vStream?.height) height = Number(vStream.height)
    } catch {
      // Animated WebP chunks can fail ffprobe 4.x; fall back to standard sticker dimensions.
    }
    return {
      sizeBytes: stat.size,
      formatName: 'webp',
      isWebp: true,
      hasVideo: true,
      hasAudio: false,
      isAnimated: animated,
      width,
      height,
      durationSeconds: 0,
      videoCodec: 'webp',
      audioCodec: null,
      sampleRate: null,
      channels: null
    }
  }

  let parsed
  try {
    const { stdout } = await runExec(config.ffprobePath, [
      '-v', 'error',
      '-show_format',
      '-show_streams',
      '-of', 'json',
      filePath
    ], 15000)
    parsed = JSON.parse(stdout)
  } catch (err) {
    throw new MediaError('INVALID_MEDIA', 'File media rusak atau formatnya tidak didukung.', err)
  }

  const streams = parsed.streams || []
  const videoStream = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1)
  const audioStream = streams.find((s) => s.codec_type === 'audio')

  if (!videoStream && !audioStream) {
    throw new MediaError('UNSUPPORTED_MEDIA', 'Format file tidak didukung atau tidak memiliki stream media.')
  }

  const formatName = String(parsed.format?.format_name || '').toLowerCase()
  const durationSeconds = Number(
    parsed.format?.duration ??
      videoStream?.duration ??
      audioStream?.duration ??
      0
  )

  const nbFrames = Number(videoStream?.nb_frames || 0)
  const isGif = formatName.includes('gif') || videoStream?.codec_name === 'gif'
  const isStillImageCodec = ['mjpeg', 'png', 'bmp', 'webp', 'tiff'].includes(videoStream?.codec_name || '')
  const isAnimated = Boolean(
    videoStream &&
      (isGif ||
        (!isStillImageCodec && (nbFrames > 1 || durationSeconds > 0.1 || formatName.includes('mp4') || formatName.includes('mov') || formatName.includes('matroska') || formatName.includes('webm'))))
  )

  return {
    sizeBytes: stat.size,
    formatName,
    isWebp: false,
    hasVideo: Boolean(videoStream),
    hasAudio: Boolean(audioStream),
    isAnimated,
    width: videoStream?.width ? Number(videoStream.width) : null,
    height: videoStream?.height ? Number(videoStream.height) : null,
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    videoCodec: videoStream?.codec_name || null,
    audioCodec: audioStream?.codec_name || null,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : null,
    channels: audioStream?.channels ? Number(audioStream.channels) : null
  }
}

const CROP_ALIASES = {
  center: 'center',
  tengah: 'center',
  crop: 'center',
  square: 'center',
  kotak: 'center',
  top: 'top',
  atas: 'top',
  bottom: 'bottom',
  bawah: 'bottom',
  left: 'left',
  kiri: 'left',
  right: 'right',
  kanan: 'right',
  none: 'none',
  full: 'none',
  fit: 'none',
  nocrop: 'none',
  utuh: 'none',
  custom: 'custom'
}

function clampUnit(value, fallback = 0.5) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(1, Math.max(0, num))
}

export function normalizeCropMode(value, fallback = config.stickerCropMode || 'center') {
  if (value !== undefined && value !== null && String(value).trim() !== '') {
    const key = String(value).trim().toLowerCase()
    if (key in CROP_ALIASES) return CROP_ALIASES[key]
  }
  const fbKey = String(fallback || 'center').trim().toLowerCase()
  return CROP_ALIASES[fbKey] || 'center'
}

export function parseCropFromArgs(args = [], fallback = config.stickerCropMode || 'center') {
  for (const token of args) {
    const key = String(token || '').trim().toLowerCase()
    if (key in CROP_ALIASES) return CROP_ALIASES[key]
  }
  return normalizeCropMode(fallback, 'center')
}

export function buildVisualFilter(canvas, cropMode = 'center', fps = null, { cropX = null, cropY = null } = {}) {
  const mode = normalizeCropMode(cropMode)
  const parts = []
  if (fps) parts.push(`fps=${fps}`)

  if (mode === 'none') {
    parts.push(
      `scale=${canvas}:${canvas}:force_original_aspect_ratio=decrease:flags=lanczos`,
      'format=rgba',
      `pad=${canvas}:${canvas}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
    )
    return parts.join(',')
  }

  let cropExpr = `crop=${canvas}:${canvas}:(iw-${canvas})/2:(ih-${canvas})/2`
  if (mode === 'custom' || (cropX !== null && cropX !== undefined) || (cropY !== null && cropY !== undefined)) {
    const xRatio = clampUnit(cropX, 0.5)
    const yRatio = clampUnit(cropY, 0.5)
    cropExpr = `crop=${canvas}:${canvas}:(iw-${canvas})*${xRatio.toFixed(4)}:(ih-${canvas})*${yRatio.toFixed(4)}`
  } else if (mode === 'top') {
    cropExpr = `crop=${canvas}:${canvas}:(iw-${canvas})/2:0`
  } else if (mode === 'bottom') {
    cropExpr = `crop=${canvas}:${canvas}:(iw-${canvas})/2:ih-${canvas}`
  } else if (mode === 'left') {
    cropExpr = `crop=${canvas}:${canvas}:0:(ih-${canvas})/2`
  } else if (mode === 'right') {
    cropExpr = `crop=${canvas}:${canvas}:iw-${canvas}:(ih-${canvas})/2`
  }

  parts.push(
    `scale=${canvas}:${canvas}:force_original_aspect_ratio=increase:flags=lanczos`,
    cropExpr,
    'format=rgba'
  )
  return parts.join(',')
}

/**
 * Converts a static image (JPG/PNG/WebP/etc.) to a 512x512 WebP sticker (1:1 cropped by default) with EXIF metadata.
 */
export async function convertToStaticSticker(inputPath, outPath, {
  quality = 80,
  crop = config.stickerCropMode,
  cropX = null,
  cropY = null,
  packName = config.stickerPackName,
  author = config.stickerAuthor,
  emojis = ['🔊']
} = {}) {
  const cropMode = normalizeCropMode(crop)
  const vf = buildVisualFilter(512, cropMode, null, { cropX, cropY })

  return mediaJobQueue.run(async () => {
    const qualities = [Math.min(95, Math.max(20, quality)), 65, 50, 35]
    let finalBuffer = null

    for (const q of qualities) {
      await runExec(config.ffmpegPath, [
        '-y',
        '-i', inputPath,
        '-vf', vf,
        '-frames:v', '1',
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', String(q),
        outPath
      ])

      const raw = await fs.readFile(outPath)
      finalBuffer = injectStickerExif(raw, { packName, author, emojis })
      if (finalBuffer.length <= MAX_STATIC_WEBP_BYTES) break
    }

    await fs.writeFile(outPath, finalBuffer)
    return {
      outputPath: outPath,
      buffer: finalBuffer,
      sizeBytes: finalBuffer.length,
      width: 512,
      height: 512,
      isAnimated: false,
      cropMode
    }
  })
}

/**
 * Converts a video or GIF into a 512x512 animated WebP sticker (1:1 cropped by default) with adaptive compression under ~490 KB.
 */
export async function convertToAnimatedSticker(inputPath, outPath, {
  start = 0,
  duration = config.maxDurationSeconds,
  fps = 12,
  quality = 65,
  crop = config.stickerCropMode,
  cropX = null,
  cropY = null,
  packName = config.stickerPackName,
  author = config.stickerAuthor,
  emojis = ['🔊']
} = {}) {
  const cropMode = normalizeCropMode(crop)
  const safeStart = Math.max(0, Number(start) || 0)
  const safeDuration = Math.min(config.maxDurationSeconds, Math.max(0.3, Number(duration) || config.maxDurationSeconds))
  const safeFps = Math.min(20, Math.max(6, Number(fps) || 12))
  const safeQuality = Math.min(90, Math.max(20, Number(quality) || 65))

  // Progressive compression ladder preserving user-selected duration first, only shortening as last resort
  const attempts = [
    { fps: safeFps, quality: safeQuality, dur: safeDuration, canvas: 512 },
    { fps: Math.min(safeFps, 10), quality: Math.min(safeQuality, 50), dur: safeDuration, canvas: 512 },
    { fps: 8, quality: 38, dur: safeDuration, canvas: 384 },
    { fps: 6, quality: 28, dur: safeDuration, canvas: 320 },
    { fps: 6, quality: 24, dur: Math.min(safeDuration, 5), canvas: 320 }
  ]

  return mediaJobQueue.run(async () => {
    let finalBuffer = null
    let appliedDuration = safeDuration

    for (const attempt of attempts) {
      appliedDuration = attempt.dur
      const vf = buildVisualFilter(attempt.canvas, cropMode, attempt.fps, { cropX, cropY })

      const args = ['-y']
      if (safeStart > 0) args.push('-ss', safeStart.toFixed(3))
      args.push(
        '-i', inputPath,
        '-t', attempt.dur.toFixed(3),
        '-an',
        '-vf', vf,
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', String(attempt.quality),
        '-preset', 'default',
        '-loop', '0',
        outPath
      )

      await runExec(config.ffmpegPath, args)
      const raw = await fs.readFile(outPath)
      finalBuffer = injectStickerExif(raw, { packName, author, emojis })
      if (finalBuffer.length <= MAX_ANIMATED_WEBP_BYTES) break
    }

    await fs.writeFile(outPath, finalBuffer)
    return {
      outputPath: outPath,
      buffer: finalBuffer,
      sizeBytes: finalBuffer.length,
      width: 512,
      height: 512,
      isAnimated: true,
      durationSeconds: appliedDuration,
      cropMode
    }
  })
}

/**
 * Smart visual converter: handles images, videos, GIFs, and existing static/animated WebP stickers.
 */
export async function convertVisualToSticker(inputPath, outPath, options = {}) {
  const probe = await inspectMediaFile(inputPath, { maxInputSizeMb: options.maxInputSizeMb })
  if (!probe.hasVideo) {
    throw new MediaError('NO_VISUAL_STREAM', 'File ini tidak memiliki gambar atau video.')
  }

  // Existing WebP sticker: preserve animated WebP natively without re-decoding failure
  if (probe.isWebp) {
    const raw = await fs.readFile(inputPath)
    if (probe.isAnimated) {
      const withExif = injectStickerExif(raw, {
        packName: options.packName || config.stickerPackName,
        author: options.author || config.stickerAuthor,
        emojis: options.emojis || ['🔊']
      })
      await fs.writeFile(outPath, withExif)
      return {
        outputPath: outPath,
        buffer: withExif,
        sizeBytes: withExif.length,
        width: probe.width || 512,
        height: probe.height || 512,
        isAnimated: true
      }
    }
    return convertToStaticSticker(inputPath, outPath, options)
  }

  if (probe.isAnimated) {
    const startSec = Math.max(0, Number(options.start) || 0)
    const remaining = probe.durationSeconds > 0 ? Math.max(0.3, probe.durationSeconds - startSec) : config.maxDurationSeconds
    const effectiveDuration = Math.min(remaining, options.duration || config.maxDurationSeconds)
    return convertToAnimatedSticker(inputPath, outPath, {
      ...options,
      start: startSec,
      duration: effectiveDuration
    })
  }

  return convertToStaticSticker(inputPath, outPath, options)
}

/**
 * Converts any audio file or video audio stream to verified WhatsApp-compatible OGG Opus (48kHz mono).
 */
export async function convertToStickerAudio(inputPath, outPath, {
  start = 0,
  duration = config.maxDurationSeconds,
  maxDurationSeconds = config.maxDurationSeconds,
  maxInputSizeMb = config.maxInputSizeMb
} = {}) {
  const probe = await inspectMediaFile(inputPath, { maxInputSizeMb })
  if (!probe.hasAudio) {
    throw new MediaError('NO_AUDIO_STREAM', 'File ini tidak memiliki suara.')
  }

  const safeStart = Math.max(0, Number(start) || 0)
  if (probe.durationSeconds > 0 && safeStart >= probe.durationSeconds - 0.05) {
    throw new MediaError('INVALID_AUDIO_RANGE', 'Titik awal audio melebihi panjang file audio.')
  }
  const targetMax = Math.min(maxDurationSeconds, Math.max(0.3, Number(duration) || maxDurationSeconds))
  const remaining = probe.durationSeconds > 0 ? Math.max(0.3, probe.durationSeconds - safeStart) : targetMax
  const effectiveDuration = Math.min(targetMax, remaining)
  const trimmed = probe.durationSeconds > effectiveDuration + 0.25

  return mediaJobQueue.run(async () => {
    const args = ['-y']
    if (safeStart > 0) args.push('-ss', safeStart.toFixed(3))
    args.push(
      '-i', inputPath,
      '-t', effectiveDuration.toFixed(3),
      '-vn',
      '-af', 'alimiter=limit=0.95',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ac', '1',
      '-ar', '48000',
      '-application', 'voip',
      outPath
    )

    try {
      await runExec(config.ffmpegPath, args)
    } catch (err) {
      if (err instanceof MediaError) throw err
      throw new MediaError('AUDIO_CONVERT_FAILED', 'Gagal memproses audio. Pastikan file tidak rusak.', err)
    }

    const outProbe = await inspectMediaFile(outPath, { maxInputSizeMb })
    if (!outProbe.hasAudio || outProbe.durationSeconds <= 0) {
      throw new MediaError('INVALID_OUTPUT_AUDIO', 'Audio hasil konversi kosong atau tidak valid.')
    }

    const buffer = await fs.readFile(outPath)
    return {
      outputPath: outPath,
      buffer,
      sizeBytes: buffer.length,
      durationSeconds: outProbe.durationSeconds,
      seconds: Math.max(1, Math.round(outProbe.durationSeconds)),
      trimmed,
      codec: outProbe.audioCodec,
      sampleRate: outProbe.sampleRate,
      channels: outProbe.channels,
      mimetype: 'audio/ogg; codecs=opus'
    }
  })
}

/**
 * Extracts full audio from a video file (for the .audio command), capped safely at 180 seconds.
 */
export async function extractAudioFromVideo(inputPath, outPath, {
  maxExtractSeconds = 180,
  maxInputSizeMb = config.maxInputSizeMb
} = {}) {
  const probe = await inspectMediaFile(inputPath, { maxInputSizeMb })
  if (!probe.hasAudio) {
    throw new MediaError('NO_AUDIO_STREAM', 'Video ini tidak memiliki suara.')
  }

  return mediaJobQueue.run(async () => {
    await runExec(config.ffmpegPath, [
      '-y',
      '-t', String(maxExtractSeconds),
      '-i', inputPath,
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '64k',
      '-ac', '2',
      '-ar', '48000',
      outPath
    ])

    const outProbe = await inspectMediaFile(outPath, { maxInputSizeMb })
    const buffer = await fs.readFile(outPath)
    return {
      outputPath: outPath,
      buffer,
      sizeBytes: buffer.length,
      durationSeconds: outProbe.durationSeconds,
      seconds: Math.max(1, Math.round(outProbe.durationSeconds)),
      mimetype: 'audio/ogg; codecs=opus'
    }
  })
}
