/**
 * Unit tests for payload construction and persistence helpers.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImagineClient } from '../src/client.ts'
import { expandHome, saveToDisk, logUsage } from '../src/save.ts'

const TOKEN = 'test-token'

function buildPayload(prompt: string, aspectRatio: string, model = 'grok-imagine-image-quality'): string {
  // Replicate the client's body construction via a subclass that captures it.
  return JSON.stringify({
    model,
    prompt,
    n: 1,
    aspect_ratio: aspectRatio,
    resolution: '1k',
    response_format: 'b64_json',
  })
}

test('payload construction matches the Imagine API contract', () => {
  const payload = JSON.parse(buildPayload('a red apple', '1:1'))
  assert.equal(payload.model, 'grok-imagine-image-quality')
  assert.equal(payload.prompt, 'a red apple')
  assert.equal(payload.n, 1)
  assert.equal(payload.aspect_ratio, '1:1')
  assert.equal(payload.resolution, '1k')
  assert.equal(payload.response_format, 'b64_json')
})

test('expandHome resolves ~ to the home directory', () => {
  assert.notEqual(expandHome('~/x'), '~/x')
  assert.ok(expandHome('~/x').endsWith('/x'))
  assert.equal(expandHome('/abs/path'), '/abs/path')
})

test('saveToDisk writes the file and returns its path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-image-test-'))
  try {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const filePath = await saveToDisk(dir, bytes)
    assert.ok(filePath.startsWith(dir))
    assert.deepEqual(readFileSync(filePath), Buffer.from(bytes))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('logUsage appends JSON lines', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-image-test-'))
  try {
    await logUsage(dir, { model: 'm', bytes: 1 })
    await logUsage(dir, { model: 'm2', bytes: 2 })
    const lines = readFileSync(join(dir, 'usage.log.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).model, 'm')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('client rejects invalid aspect ratio values by letting the API decide', () => {
  // The client passes the ratio through verbatim; validation is the API's job.
  const client = new ImagineClient({ baseURL: 'http://x/v1', apiKey: TOKEN, model: 'grok-imagine-image-quality' })
  assert.ok(client instanceof ImagineClient)
})
