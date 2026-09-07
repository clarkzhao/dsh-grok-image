/**
 * ImagineClient: calls the Grok Imagine subscription endpoint to generate
 * images. Mirrors the wire behaviour of grok-build's `image_gen` tool:
 * `POST {baseURL}/images/generations` with `response_format: b64_json`.
 *
 * Connection facts arrive through a thunk resolved once per call so a
 * settings change reaches the next request; an in-flight generate keeps the
 * facts it started with. Talks through an undici ProxyAgent when configured.
 */

import { ProxyAgent, fetch as undiciFetch } from 'undici'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'

export interface ImagineOptions {
  baseURL: string
  model: string
  proxy?: string
}

/** Match the installed grok CLI so cli-chat-proxy version-gating stays happy. */
const GROK_CLIENT_VERSION = '1.0.13'
/** JPEG SOI marker: first two bytes of every JPEG stream. */
const JPEG_SOI_0 = 0xff
const JPEG_SOI_1 = 0xd8

export interface GeneratedImage {
  /** Decoded JPEG bytes. */
  bytes: Uint8Array
  /** Media type of the decoded payload. */
  mediaType: 'image/jpeg'
}

export class ImagineClient {
  private readonly options: () => ImagineOptions
  private dispatcher: ProxyAgent | undefined
  private dispatcherProxy: string | undefined

  constructor(options: () => ImagineOptions) {
    this.options = options
  }

  /** Close the underlying proxy agent; call once when the client is retired. */
  dispose(): void {
    this.dispatcher?.close().catch(() => undefined)
    this.dispatcher = undefined
    this.dispatcherProxy = undefined
  }

  private dispatcherFor(proxy: string | undefined): ProxyAgent | undefined {
    if (proxy === undefined || proxy.length === 0) {
      if (this.dispatcher !== undefined) {
        this.dispatcher.close().catch(() => undefined)
        this.dispatcher = undefined
        this.dispatcherProxy = undefined
      }
      return undefined
    }
    if (this.dispatcher !== undefined && this.dispatcherProxy === proxy) return this.dispatcher
    if (this.dispatcher !== undefined) this.dispatcher.close().catch(() => undefined)
    this.dispatcher = new ProxyAgent(proxy)
    this.dispatcherProxy = proxy
    return this.dispatcher
  }

  private headers(apiKey: string, model: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'X-XAI-Token-Auth': 'xai-grok-cli',
      'x-authenticateresponse': 'authenticate-response',
      'x-grok-client-version': GROK_CLIENT_VERSION,
      'x-grok-client-identifier': 'dsh-grok-image',
      'x-grok-model-override': model,
      ...attributionHeaders(),
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
    const connection = this.options()
    const url = `${connection.baseURL.replace(/\/+$/, '')}/images/generations`
    const body = JSON.stringify({
      model: connection.model,
      prompt,
      n: 1,
      aspect_ratio: aspectRatio,
      resolution: '1k',
      response_format: 'b64_json',
    })

    const response = await undiciFetch(url, {
      method: 'POST',
      headers: this.headers(apiKey, connection.model),
      body,
      signal,
      dispatcher: this.dispatcherFor(connection.proxy),
    }) as unknown as Response

    if (!response.ok) {
      // Drain the body so the socket can close, but never put it on the
      // Error — an upstream gateway may echo Authorization / JWT.
      await response.text().catch(() => '')
      throw new Error(`Grok image generation failed (http_${response.status})`)
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
