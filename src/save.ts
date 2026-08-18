/**
 * Persistence helpers for generated images.
 *
 * Every image is (a) committed to the DSH attachment store so the Web UI
 * renders it inline and the model can see it, and (b) written to a disk
 * directory so the user has a plain file to inspect. Usage is appended to
 * `usage.log.jsonl` in the output directory for local cost accounting
 * (the Imagine API returns no per-call usage/cost).
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Write bytes to `<outputDir>/grok-<timestamp>.jpg` and return the path. */
export async function saveToDisk(outputDir: string, bytes: Uint8Array): Promise<string> {
  const dir = expandHome(outputDir)
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filePath = join(dir, `grok-${stamp}.jpg`)
  await writeFile(filePath, bytes)
  return filePath
}

/** Commit one image to the DSH attachment store; returns the durable ref. */
export async function saveToAttachments(
  attachments: AttachmentStore,
  bytes: Uint8Array,
  filePath: string,
): Promise<ImageAttachmentRef> {
  return attachments.saveImage({
    data: bytes,
    mediaType: 'image/jpeg',
    name: basename(filePath),
  })
}

/** Append one JSON line to `<outputDir>/usage.log.jsonl`. */
export async function logUsage(outputDir: string, entry: Record<string, unknown>): Promise<void> {
  const dir = expandHome(outputDir)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'usage.log.jsonl')
  await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
}
