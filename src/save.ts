/**
 * Persistence helpers for generated images.
 *
 * Every image is (a) committed to the DSH attachment store so the Web UI
 * renders it inline and the model can see it, and (b) written to a disk
 * directory so the user has a plain file to inspect. Usage is appended to
 * `usage.log.jsonl` in the output directory for local cost accounting
 * (the Imagine API returns no per-call usage/cost).
 *
 * Security: output paths are confined to the configured directory (resolved
 * `..` escapes are rejected), and all files/dirs are created private
 * (0600 / 0700).
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/** Resolve a config-provided output directory; throws on `..` escapes. */
export function resolveOutputDir(outputDir: string): string {
  const expanded = expandHome(outputDir)
  if (expanded.split(sep).includes('..')) {
    throw new Error(`dsh-grok-image: outputDir must not contain '..' (got ${outputDir})`)
  }
  return resolve(expanded)
}

/**
 * Confine a generated filename inside `outputDir`. The name is always
 * internally generated (`grok-<uuid>.jpg`), but double-check anyway so a
 * future caller cannot write outside the configured directory.
 */
export function confinePath(dir: string, name: string): string {
  const filePath = resolve(dir, name)
  if (!filePath.startsWith(dir + sep) && filePath !== dir) {
    throw new Error(`dsh-grok-image: refused to write outside outputDir (${filePath})`)
  }
  return filePath
}

/** Write bytes to `<outputDir>/grok-<uuid>.jpg` (private 0600) and return the path. */
export async function saveToDisk(outputDir: string, bytes: Uint8Array): Promise<string> {
  const dir = resolveOutputDir(outputDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const filePath = confinePath(dir, `grok-${randomUUID()}.jpg`)
  await writeFile(filePath, bytes, { mode: 0o600 })
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

/** Append one JSON line to `<outputDir>/usage.log.jsonl` (private 0600). */
export async function logUsage(outputDir: string, entry: Record<string, unknown>): Promise<void> {
  const dir = resolveOutputDir(outputDir)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const file = confinePath(dir, 'usage.log.jsonl')
  await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, {
    mode: 0o600,
  })
}
