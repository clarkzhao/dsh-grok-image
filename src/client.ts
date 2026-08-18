/**
 * ImagineClient: calls the Grok Imagine subscription endpoint to generate
 * images. Mirrors the wire behaviour of grok-build's `image_gen` tool:
 * `POST {baseURL}/images/generations` with `response_format: b64_json`.
 *
 * Talks through an undici ProxyAgent (e.g. Clash `http://127.0.0.1:7890`),
 * using the same headers as the dsh-llm-grok chat adapter.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'

export interface ImagineOptions {
  baseURL: string
  apiKey: string
  model: string
  proxy?: string
  /** Total request timeout; image generation can take well over a minute. */
  timeoutMs?: number
}

const GROK_CLIENT_VERSION = '1.0.4'
const DEFAULT_TIMEOUT_MS = 300_000

export interface GeneratedImage {
  /** Decoded JPEG bytes. */
  bytes: Uint8Array
  /** Media type of the decoded payload. */
  mediaType: 'image/jpeg'
}

export class ImagineClient {
  private readonly dispatcher: ProxyAgent | undefined
  private readonly options: ImagineOptions

  constructor(options: ImagineOptions) {
    this.options = options
    this.dispatcher = options.proxy ? new ProxyAgent(options.proxy) : undefined
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.options.apiKey}`,
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
   * @param signal - optional caller cancellation, forwarded to the request.
   * @returns the decoded JPEG bytes.
   */
  async generate(prompt: string, aspectRatio: string, signal?: AbortSignal): Promise<GeneratedImage> {
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

    try {
      const response = await undiciFetch(url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: controller.signal,
        dispatcher: this.dispatcher,
      }) as unknown as Response

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(
          `Grok image generation failed (${response.status}): ${text.slice(0, 300)}`,
        )
      }

      const json = await response.json() as { data?: Array<{ b64_json?: string }> }
      const b64 = json.data?.[0]?.b64_json
      if (b64 === undefined || b64.length === 0) {
        throw new Error('Grok image generation returned no image data')
      }
      return { bytes: new Uint8Array(Buffer.from(b64, 'base64')), mediaType: 'image/jpeg' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}
