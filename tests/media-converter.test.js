import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { config } from '../src/config.js'
import {
  convertToAnimatedSticker,
  convertToStaticSticker,
  convertToStickerAudio,
  convertVisualToSticker,
  inspectMediaFile,
  MediaError
} from '../src/services/media-converter.js'
import { isAnimatedWebp } from '../src/services/sticker-exif.js'
import { withJobTempDir } from '../src/utils/cleanup.js'

const execFileAsync = promisify(execFile)

async function runFfmpeg(args) {
  await execFileAsync(config.ffmpegPath, args, { timeout: 25000, windowsHide: true })
}

let workDir

test.before(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-audio-sticker-media-test-'))

  // Create synthetic test fixtures:
  // 1. Wide PNG image (800x400) to verify aspect ratio preservation & transparent padding
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'color=c=crimson:s=800x400:d=1',
    '-frames:v', '1', path.join(workDir, 'sample.png')
  ])

  // 2. MP4 video WITH audio (3s)
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    path.join(workDir, 'video-with-audio.mp4')
  ])

  // 3. MP4 video WITHOUT audio (2s)
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=12',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    path.join(workDir, 'video-silent.mp4')
  ])

  // 4. Animated GIF (2s)
  await runFfmpeg([
    '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=200x200:rate=10',
    path.join(workDir, 'anim.gif')
  ])

  // 5. WAV audio (3s) + long WAV audio (12s) + WhatsApp-like OGG Opus voice note (2s)
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=523:duration=3',
    path.join(workDir, 'sound.wav')
  ])
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=12',
    path.join(workDir, 'long-sound.wav')
  ])
  await runFfmpeg([
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=2',
    '-c:a', 'libopus', '-ar', '48000', '-ac', '1',
    path.join(workDir, 'voicenote.ogg')
  ])

  // 6. Corrupted file
  await fs.writeFile(path.join(workDir, 'corrupt.mp4'), Buffer.from('not-a-valid-media-file-12345'))
})

test.after(async () => {
  if (workDir) await fs.rm(workDir, { recursive: true, force: true })
})

test('1. Static PNG image + WAV audio -> 512x512 WebP with EXIF & OGG Opus audio', async () => {
  const stickerOut = path.join(workDir, 'out-static.webp')
  const audioOut = path.join(workDir, 'out-static.ogg')

  const sticker = await convertToStaticSticker(path.join(workDir, 'sample.png'), stickerOut, {
    packName: 'Test Pack',
    author: 'Test Author'
  })
  const audio = await convertToStickerAudio(path.join(workDir, 'sound.wav'), audioOut)

  assert.equal(sticker.width, 512)
  assert.equal(sticker.height, 512)
  assert.equal(sticker.isAnimated, false)
  assert.ok(sticker.buffer.includes(Buffer.from('EXIF', 'ascii')), 'EXIF chunk must be embedded')
  assert.ok(sticker.buffer.includes(Buffer.from('Test Pack', 'utf8')), 'Pack name must be in EXIF')

  assert.equal(audio.codec, 'opus')
  assert.equal(audio.sampleRate, 48000)
  assert.equal(audio.channels, 1)
  assert.equal(audio.mimetype, 'audio/ogg; codecs=opus')
  assert.ok(audio.durationSeconds >= 2.5 && audio.durationSeconds <= 3.5)
})

test('2. Video MP4 with original audio -> animated 512x512 WebP + extracted OGG Opus', async () => {
  const videoPath = path.join(workDir, 'video-with-audio.mp4')
  const stickerOut = path.join(workDir, 'out-video.webp')
  const audioOut = path.join(workDir, 'out-video.ogg')

  const sticker = await convertToAnimatedSticker(videoPath, stickerOut, { duration: 3 })
  const audio = await convertToStickerAudio(videoPath, audioOut, { duration: 3 })

  assert.equal(sticker.isAnimated, true)
  assert.equal(isAnimatedWebp(sticker.buffer), true)
  assert.ok(sticker.buffer.includes(Buffer.from('EXIF', 'ascii')))
  assert.ok(sticker.sizeBytes <= 500 * 1024, 'Animated sticker should fit within ~500 KB budget')
  assert.equal(audio.codec, 'opus')
})

test('3. Animated GIF + separate audio -> animated WebP + OGG Opus', async () => {
  const gifPath = path.join(workDir, 'anim.gif')
  const stickerOut = path.join(workDir, 'out-gif.webp')

  const sticker = await convertVisualToSticker(gifPath, stickerOut)
  assert.equal(sticker.isAnimated, true)
  assert.equal(isAnimatedWebp(sticker.buffer), true)
})

test('4. Existing WebP sticker (animated) preserves animation and injects EXIF', async () => {
  const animatedWebpPath = path.join(workDir, 'out-video.webp')
  const rewrappedOut = path.join(workDir, 'out-existing-sticker.webp')

  const result = await convertVisualToSticker(animatedWebpPath, rewrappedOut, {
    packName: 'Rewrapped Pack',
    author: 'Tester'
  })
  assert.equal(result.isAnimated, true)
  assert.equal(isAnimatedWebp(result.buffer), true)
  assert.ok(result.buffer.includes(Buffer.from('Rewrapped Pack', 'utf8')))
})

test('5. WhatsApp voice note (OGG Opus) converts cleanly for sticker audio', async () => {
  const vnPath = path.join(workDir, 'voicenote.ogg')
  const audioOut = path.join(workDir, 'out-vn.ogg')

  const audio = await convertToStickerAudio(vnPath, audioOut)
  assert.equal(audio.codec, 'opus')
  assert.equal(audio.sampleRate, 48000)
  assert.ok(audio.durationSeconds >= 1.5 && audio.durationSeconds <= 2.5)
})

test('6. Video without audio stream is rejected with NO_AUDIO_STREAM', async () => {
  const silentVideo = path.join(workDir, 'video-silent.mp4')
  const audioOut = path.join(workDir, 'should-not-exist.ogg')

  await assert.rejects(
    () => convertToStickerAudio(silentVideo, audioOut),
    (err) => err instanceof MediaError && err.code === 'NO_AUDIO_STREAM'
  )
})

test('7. Audio exceeding configured duration is automatically trimmed', async () => {
  const longWav = path.join(workDir, 'long-sound.wav')
  const audioOut = path.join(workDir, 'out-trimmed.ogg')

  const audio = await convertToStickerAudio(longWav, audioOut, {
    duration: 4,
    maxDurationSeconds: 4
  })

  assert.equal(audio.trimmed, true)
  assert.ok(audio.durationSeconds <= 4.3, `Expected trimmed audio <= 4.3s, got ${audio.durationSeconds}`)
})

test('8. Invalid and corrupted media is rejected cleanly', async () => {
  const corruptPath = path.join(workDir, 'corrupt.mp4')
  await assert.rejects(
    () => inspectMediaFile(corruptPath),
    (err) => err instanceof MediaError && err.code === 'INVALID_MEDIA'
  )
})

test('9. Oversized media is rejected before FFmpeg runs', async () => {
  const samplePath = path.join(workDir, 'video-with-audio.mp4')
  await assert.rejects(
    () => inspectMediaFile(samplePath, { maxInputSizeMb: 0.0001 }),
    (err) => err instanceof MediaError && err.code === 'FILE_TOO_LARGE'
  )
})

test('17. Temporary job directories are cleaned up on both success and failure', async () => {
  let createdSuccessDir = ''
  await withJobTempDir(async (dir) => {
    createdSuccessDir = dir
    await fs.writeFile(path.join(dir, 'temp.txt'), 'ok')
  }, 'test-ok', workDir)

  await assert.rejects(() => fs.access(createdSuccessDir))

  let createdFailDir = ''
  await assert.rejects(async () => {
    await withJobTempDir(async (dir) => {
      createdFailDir = dir
      await fs.writeFile(path.join(dir, 'temp.txt'), 'fail')
      throw new Error('simulated failure')
    }, 'test-fail', workDir)
  })

  await assert.rejects(() => fs.access(createdFailDir))
})

test('Crop modes: center (default 1:1), top, bottom, left, right, and none (full) all produce valid 512x512 WebP', async () => {
  const { parseCropFromArgs, buildVisualFilter } = await import('../src/services/media-converter.js')

  assert.equal(parseCropFromArgs([]), 'center')
  assert.equal(parseCropFromArgs(['atas']), 'top')
  assert.equal(parseCropFromArgs(['bawah']), 'bottom')
  assert.equal(parseCropFromArgs(['kiri']), 'left')
  assert.equal(parseCropFromArgs(['kanan']), 'right')
  assert.equal(parseCropFromArgs(['full']), 'none')
  assert.match(buildVisualFilter(512, 'center'), /force_original_aspect_ratio=increase/)
  assert.match(buildVisualFilter(512, 'none'), /force_original_aspect_ratio=decrease/)

  // Test crop on wide image (800x400) and video across modes
  for (const mode of ['center', 'top', 'bottom', 'left', 'right', 'none']) {
    const outImg = path.join(workDir, `crop-img-${mode}.webp`)
    const res = await convertToStaticSticker(path.join(workDir, 'sample.png'), outImg, { crop: mode })
    assert.equal(res.width, 512)
    assert.equal(res.height, 512)
    assert.equal(res.cropMode, mode)
    assert.ok(res.sizeBytes > 500)
  }

  const outVidCrop = path.join(workDir, 'crop-vid-top.webp')
  const vidRes = await convertToAnimatedSticker(path.join(workDir, 'video-with-audio.mp4'), outVidCrop, {
    duration: 2,
    crop: 'top'
  })
  assert.equal(vidRes.isAnimated, true)
  assert.equal(vidRes.cropMode, 'top')
  assert.equal(isAnimatedWebp(vidRes.buffer), true)
})

