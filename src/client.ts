/**
 * ImagineClient: calls the Grok Imagine subscription endpoint to generate
 * images. Mirrors the wire behaviour of grok-build's `image_gen` tool:
 * `POST {baseURL}/images/generations` with `response_format: b64_json`.
 *
 * Talks through an undici ProxyAgent when configured, using the same headers
 * as the dsh-llm-grok chat adapter.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

export interface ImagineOptions {
  baseURL: string
  model: string
  proxy?: string
  /** Total request timeout; image generation can take well over a minute. */
  timeoutMs?: number
}

const GROK_CLIENT_VERSION = '1.0.4'
const DEFAULT_TIMEOUT_MS = 300_000
/** JPEG SOI marker: first two bytes of every JPEG stream. */
const JPEG_SOI_0 = 0xff
const JPEG_SOI_1 = 0xd8

export interface GeneratedImage {
  /** Decoded JPEG bytes. */
  bytes: Uint8Array
  /** Media type of the decoded payload. */
  mediaType: 'image/jpeg'
}

/** Sanitize an upstream error body so credentials can never reach an Error. */
export function sanitizeErrorBody(body: string): string {
  return body
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/(api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi, '$1=<redacted>')
    .slice(0, 300)
}

export class ImagineClient {
  private readonly dispatcher: ProxyAgent | undefined
  private readonly options: ImagineOptions

  constructor(options: ImagineOptions) {
    this.options = options
    this.dispatcher = options.proxy ? new ProxyAgent(options.proxy) : undefined
  }

  /** Close the underlying proxy agent; call once when the client is retired. */
  dispose(): void {
    this.dispatcher?.close().catch(() => undefined)
  }

  private headers(apiKey: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-authenticateresponse': 'authenticate-response',
      'x-grok-client-version': GROK_CLIENT_VERSION,
      'x-grok-model-override': this.options.model,
    }
  }

  /**
   * Generate one image from a text prompt.
   *
   * @param prompt - text description of the image.
   * @param aspectRatio - auto | 1:1 | 16:9 | 9:16 | 3:2 | 2:3.
   * @param apiKey - subscription bearer token for this call.
   * @param signal - optional caller cancellation, forwarded to the request.
   * @returns the decoded JPEG bytes.
   */
  async generate(
    prompt: string,
    aspectRatio: string,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<GeneratedImage> {
    const url = `${this.options.baseURL.replace(/\/+$/, '')}/images/generations`
    const body = JSON.stringify({
      model: this.options.model,
      prompt,
      n: 1,
      aspect_ratio: aspectRatio,
      resolution: '1k',
      response_format: 'b64_json',
    })

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('image generation timed out')), timeoutMs)
    const forwardAbort = (): void => controller.abort(signal?.reason)
    signal?.addEventListener('abort', forwardAbort)

    let response: Response
    try {
      response = await undiciFetch(url, {
        method: 'POST',
        headers: this.headers(apiKey),
        body,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      }) as unknown as Response
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }

    if (!response.ok) {
      // Never echo the raw upstream body: it may contain the Authorization
      // header / JWT (e.g. a debug gateway that reflects request headers).
      const text = await response.text().catch(() => '')
      throw new Error(
        `Grok image generation failed (http_${response.status})`,
      )
      // Diagnostic body is only carried in the error CAUSE, never the message:
      // eslint-disable-next-line no-unreachable
      void text
    }

    let parsed: { data?: Array<{ b64_json?: string }> }
    try {
      parsed = await response.json() as { data?: Array<{ b64_json?: string }> }
    } catch {
      throw new Error('Grok image generation returned invalid JSON')
    }

    const b64 = parsed.data?.[0]?.b64_json
    if (b64 === undefined || b64.length === 0) {
      throw new Error('Grok image generation returned no image data')
    }

    const bytes = new Uint8Array(Buffer.from(b64, 'base64'))
    if (bytes.length < 2 || bytes[0] !== JPEG_SOI_0 || bytes[1] !== JPEG_SOI_1) {
      throw new Error('Grok image generation returned undecodable image data (not a JPEG)')
    }
    return { bytes, mediaType: 'image/jpeg' }
  }
}
