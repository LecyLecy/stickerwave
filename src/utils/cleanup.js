import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from '../config.js'

export async function safeUnlink(filePath) {
  if (!filePath) return false
  try {
    await fs.unlink(filePath)
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return false
    return false
  }
}

export async function safeRmDir(dirPath) {
  if (!dirPath) return false
  try {
    await fs.rm(dirPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

export async function createJobTempDir(prefix = 'job', baseDir = config.tempDir) {
  await fs.mkdir(baseDir, { recursive: true })
  const unique = `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const dir = path.join(baseDir, unique)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export async function withJobTempDir(fn, prefix = 'job', baseDir = config.tempDir) {
  const dir = await createJobTempDir(prefix, baseDir)
  try {
    return await fn(dir)
  } finally {
    await safeRmDir(dir)
  }
}

/**
 * Simple concurrency limiter for FFmpeg/media jobs.
 */
export class JobQueue {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = Math.max(1, maxConcurrent)
    this.active = 0
    this.waiting = []
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        this.active += 1
        try {
          const result = await task()
          resolve(result)
        } catch (err) {
          reject(err)
        } finally {
          this.active -= 1
          if (this.waiting.length > 0) {
            const next = this.waiting.shift()
            next()
          }
        }
      }

      if (this.active < this.maxConcurrent) {
        execute()
      } else {
        this.waiting.push(execute)
      }
    })
  }
}
