/**
 * Unit tests: payload/wire contract via a real HTTP mock, credential
 * redaction, save helper confinement, and result rendering.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImagineClient } from '../src/client.ts'
import { renderImageResult } from '../src/render.ts'
import { confinePath, expandHome, logUsage, resolveOutputDir, saveToDisk } from '../src/save.ts'

const MODEL = 'grok-imagine-image-quality'
const FAKE_JWT = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.ADVERSARIAL_FAKE_TOKEN'

/** A tiny valid 1x1 JPEG. */
const JPEG_B64 = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABD/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/EB//xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/EB//xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/EB//2Q=='

interface MockRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

function startMock(
  handler: (req: IncomingMessage, body: string) => Promise<{ status: number; body: string }> | { status: number; body: string },
): Promise<{ url: string; close: () => Promise<void>; requests: MockRequest[] }> {
  const requests: MockRequest[] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body,
      })
      Promise.resolve(handler(req, body)).then((out) => {
        res.writeHead(out.status, { 'Content-Type': 'application/json' })
        res.end(out.body)
      }).catch((error) => {
        // A failing assertion inside the handler must surface as a test
        // failure, not leave the request hanging forever.
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ testHandlerError: String(error && error.message || error) }))
      })
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((res) => {
          // Abort tests leave a hanging connection; force-close it so close()
          // resolves instead of waiting for the peer.
          server.closeAllConnections?.()
          server.close(() => res())
        }),
        requests,
      })
    })
  })
}

test('generate posts the exact wire contract and decodes JPEG bytes', async () => {
  const mock = await startMock((req, body) => {
    assert.equal(req.method, 'POST')
    assert.equal(req.url, '/v1/images/generations')
    const parsed = JSON.parse(body)
    assert.equal(parsed.model, MODEL)
    assert.equal(parsed.prompt, 'a red apple')
    assert.equal(parsed.n, 1)
    assert.equal(parsed.aspect_ratio, '1:1')
    assert.equal(parsed.resolution, '1k')
    assert.equal(parsed.response_format, 'b64_json')
    return { status: 200, body: JSON.stringify({ data: [{ b64_json: JPEG_B64 }] }) }
  })
  try {
    const client = new ImagineClient({ baseURL: mock.url, model: MODEL })
    const { bytes, mediaType } = await client.generate('a red apple', '1:1', 'test-token')
    assert.equal(mediaType, 'image/jpeg')
    assert.ok(bytes[0] === 0xff && bytes[1] === 0xd8, 'JPEG SOI magic')
    const req = mock.requests[0]
    assert.equal(req.headers.authorization, 'Bearer test-token')
    assert.equal(req.headers['x-xai-token-auth'], 'xai-grok-cli')
    assert.equal(req.headers['x-grok-model-override'], MODEL)
  } finally {
    await mock.close()
  }
})

test('non-2xx errors never leak the bearer token even when the server reflects it', async () => {
  const mock = await startMock(() => ({
    status: 401,
    body: JSON.stringify({ error: 'invalid token', authorization: `Bearer ${FAKE_JWT}` }),
  }))
  try {
    const client = new ImagineClient({ baseURL: mock.url, model: MODEL })
    await assert.rejects(
      client.generate('x', '1:1', FAKE_JWT),
      (err: Error) => {
        assert.ok(!err.message.includes(FAKE_JWT), 'JWT must not appear in the message')
        assert.ok(!err.message.includes('Bearer'), 'Bearer header must not appear')
        assert.match(err.message, /http_401/)
        return true
      },
    )
  } finally {
    await mock.close()
  }
})

test('200 with no b64_json -> clear error', async () => {
  const mock = await startMock(() => ({ status: 200, body: JSON.stringify({ data: [] }) }))
  try {
    const client = new ImagineClient({ baseURL: mock.url, model: MODEL })
    await assert.rejects(client.generate('x', '1:1', 't'), /no image data/)
  } finally {
    await mock.close()
  }
})

test('200 with non-JSON body -> clear error', async () => {
  const mock = await startMock(() => ({ status: 200, body: 'not-json' }))
  try {
    const client = new ImagineClient({ baseURL: mock.url, model: MODEL })
    await assert.rejects(client.generate('x', '1:1', 't'), /invalid JSON/)
  } finally {
    await mock.close()
  }
})

test('abort signal cancels a pending request', async () => {
  const mock = await startMock(() => new Promise(() => undefined) as never)
  try {
    const client = new ImagineClient({ baseURL: mock.url, model: MODEL, timeoutMs: 60_000 })
    const controller = new AbortController()
    const promise = client.generate('x', '1:1', 't', controller.signal)
    controller.abort(new Error('caller-cancel'))
    await assert.rejects(promise, /caller-cancel/)
  } finally {
    await mock.close()
  }
})

test('renderImageResult emits image block only with a complete attachment', () => {
  const full = renderImageResult({
    attachmentId: 'sha256:abc',
    mediaType: 'image/jpeg',
    bytes: 100,
    width: 1024,
    height: 1024,
    name: 'x.jpg',
    filePath: '/tmp/x.jpg',
  })
  assert.equal(full[0].type, 'image')
  assert.equal(full[1].type, 'text')
  if (full[1].type === 'text') assert.match(full[1].text, /已保存到/)

  // Empty attachmentId -> no image block, text only.
  const empty = renderImageResult({ attachmentId: '', mediaType: 'image/jpeg', bytes: 10, width: 0, height: 0, filePath: '/tmp/x.jpg' })
  assert.equal(empty.length, 1)
  assert.equal(empty[0].type, 'text')

  // Missing attachment entirely -> text only.
  const missing = renderImageResult({ filePath: '/tmp/x.jpg' })
  assert.equal(missing.length, 1)
  assert.equal(missing[0].type, 'text')

  // No filePath -> empty blocks.
  const none = renderImageResult({})
  assert.equal(none.length, 0)

  const staged = renderImageResult({
    filePath: '/tmp/x.jpg',
    url: 'http://127.0.0.1:3080/airp-media/x.jpg',
    markdown: '![x.jpg](http://127.0.0.1:3080/airp-media/x.jpg)',
  })
  assert.equal(staged.length, 1)
  assert.equal(staged[0].type, 'text')
  if (staged[0].type === 'text') {
    assert.match(staged[0].text, /嵌入叙述用：!\[x\.jpg\]\(http:\/\/127\.0\.0\.1:3080\/airp-media\/x\.jpg\)/)
    assert.doesNotMatch(staged[0].text, /\/tmp\/x\.jpg/)
  }
})

test('expandHome and resolveOutputDir', () => {
  assert.equal(expandHome('~'), process.env.HOME)
  assert.ok(expandHome('~/x').endsWith('/x'))
  assert.equal(expandHome('/abs'), '/abs')
  assert.throws(() => resolveOutputDir('/tmp/../etc'), /\.\./)
  assert.equal(resolveOutputDir('/tmp/ok'), '/tmp/ok')
})

test('confinePath rejects escapes', () => {
  assert.throws(() => confinePath('/tmp/dir', '../evil.jpg'), /refused/)
  assert.equal(confinePath('/tmp/dir', 'ok.jpg'), '/tmp/dir/ok.jpg')
})

test('saveToDisk writes private files with unique names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-image-test-'))
  try {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const a = await saveToDisk(dir, bytes)
    const b = await saveToDisk(dir, bytes)
    assert.notEqual(a, b, 'filenames must not collide')
    assert.deepEqual(readFileSync(a), Buffer.from(bytes))
    assert.equal(statSync(a).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('logUsage appends JSON lines privately', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grok-image-test-'))
  try {
    await logUsage(dir, { model: 'm', bytes: 1 })
    await logUsage(dir, { model: 'm2', bytes: 2 })
    const lines = readFileSync(join(dir, 'usage.log.jsonl'), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    assert.equal(JSON.parse(lines[0]).model, 'm')
    assert.equal(statSync(join(dir, 'usage.log.jsonl')).mode & 0o777, 0o600)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
