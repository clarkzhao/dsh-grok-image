/**
 * dsh-grok-image plugin entry.
 *
 * Registers the model tool `image_gen`: generate an image from a text
 * description through the Grok Imagine subscription endpoint, using the
 * same base URL, credential (`GROK_SESSION_TOKEN`) and Clash proxy as
 * dsh-llm-grok. The result is committed to the DSH attachment store (so
 * the Web UI renders it inline) and written to disk (so the user has a
 * plain file).
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename, extname, resolve } from 'node:path'
import { ImagineClient } from './client.js'
import { renderImageResult } from './render.js'
import { logUsage, saveToAttachments, saveToDisk, expandHome } from './save.js'

export const name = 'grok-image'
export const inject = ['tools']

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const DEFAULT_API_KEY_ENV = 'GROK_SESSION_TOKEN'
const DEFAULT_MODEL = 'grok-imagine-image-quality'
/** No proxy by default; deployments behind one configure `proxy` explicitly. */
const DEFAULT_PROXY = ''
const DEFAULT_OUTPUT_DIR = '~/grok-images'
const IMAGE_GEN_TIMEOUT_MS = 300_000
/** Upper bound on prompt length: guards against quota burn on nonsense input. */
const MAX_PROMPT_LENGTH = 8_000
const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16', '3:2', '2:3'] as const
/** Media route prefix that serves generated images over the DSH web server. */
const MEDIA_ROUTE_PREFIX = '/grok-media'
const MEDIA_MAX_BYTES = 20 * 1024 * 1024
const MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
}

export interface Config {
  baseURL?: string
  apiKeyEnv?: string
  proxy?: string
  model?: string
  outputDir?: string
  usageLog?: boolean
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default(DEFAULT_BASE_URL),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  proxy: z.string().default(DEFAULT_PROXY),
  model: z.string().default(DEFAULT_MODEL),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  usageLog: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config): void {
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV
  const model = config.model ?? DEFAULT_MODEL
  const outputDir = config.outputDir ?? DEFAULT_OUTPUT_DIR

  const resolveApiKey = async (): Promise<string> => {
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(apiKeyEnv as never)
      if (hit !== undefined && hit.value.length > 0) return hit.value
    }
    const ambient = process.env[apiKeyEnv]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new Error(`dsh-grok-image: missing credential ${apiKeyEnv}`)
  }

  // One client (and one ProxyAgent) per plugin lifetime; closed on teardown.
  const client = new ImagineClient({
    baseURL: config.baseURL ?? DEFAULT_BASE_URL,
    model,
    proxy: config.proxy && config.proxy.length > 0 ? config.proxy : undefined,
  })
  ctx.effect(() => () => client.dispose())

  // Serve generated images over the DSH web server so the Web UI can
  // reference them by <origin>/grok-media/<file>. Optional: absent in a
  // headless profile without webServer.
  const webServer = ctx.get('webServer') as { register: (route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }) => () => void } | undefined
  if (webServer !== undefined) {
    const mediaRoot = resolve(expandHome(outputDir))
    const disposeRoute = webServer.register({
      kind: 'prefix',
      path: MEDIA_ROUTE_PREFIX,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405)
          res.end()
          return
        }
        const name = (req.url ?? '/').split('?')[0].split('/').pop() ?? ''
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
          res.writeHead(400, { 'Content-Type': 'text/plain' })
          res.end('bad request')
          return
        }
        try {
          const filePath = resolve(mediaRoot, name)
          const info = await stat(filePath)
          if (!info.isFile() || info.size > MEDIA_MAX_BYTES) {
            res.writeHead(404, { 'Content-Type': 'text/plain' })
            res.end('not found')
            return
          }
          const type = MEDIA_TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
          const body = await readFile(filePath)
          res.end(body)
        } catch {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
        }
      },
    })
    ctx.effect(() => () => disposeRoute())
  }

  ctx.tools.register(defineTool({
    name: 'image_gen',
    description:
      'Generate an image from a text description using Grok Imagine (subscription). '
      + 'The generated image is returned and saved to disk. '
      + 'To produce multiple images, emit multiple tool calls with distinct prompts.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Text description of the image to generate (max 8000 chars).',
      },
      aspect_ratio: {
        type: 'string',
        enum: [...ASPECT_RATIOS],
        description: "Aspect ratio of the image: auto (default), 1:1, 16:9, 9:16, 3:2, 2:3. "
          + "1:1 for square (icons, profiles), 16:9 for wide (landscapes, cinematic), "
          + "9:16 for tall (phone wallpapers, stories), 3:2 for horizontal photos, "
          + "2:3 for vertical (portraits, posters).",
      },
      inline_image: {
        type: 'boolean',
        description: 'Include the image inline in the conversation (default true). '
          + 'Set false to return only the saved file path — use this when the current '
          + 'model adapter does not support image content (e.g. deepseek).',
      },
    },
    timeoutMs: IMAGE_GEN_TIMEOUT_MS,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => renderImageResult(value as never),
    },
    async execute(args, exec: ToolRunContext) {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
      if (prompt.length === 0) {
        throw new Error('image_gen: prompt must not be empty')
      }
      if (prompt.length > MAX_PROMPT_LENGTH) {
        throw new Error(`image_gen: prompt too long (${prompt.length} > ${MAX_PROMPT_LENGTH} chars)`)
      }
      const ratio = args.aspect_ratio ?? 'auto'
      const inline = args.inline_image !== false

      const apiKey = await resolveApiKey()
      const { bytes } = await client.generate(prompt, ratio, apiKey, exec.signal)

      if (exec.signal.aborted) {
        throw new Error('image_gen: cancelled after generation')
      }

      const filePath = await saveToDisk(outputDir, bytes)

      if (exec.signal.aborted) {
        throw new Error('image_gen: cancelled after save')
      }

      const attachments = ctx.get('attachments')
      const ref = attachments !== undefined
        ? await saveToAttachments(attachments, bytes, filePath)
        : undefined

      if (config.usageLog ?? true) {
        await logUsage(outputDir, {
          model,
          aspectRatio: ratio,
          bytes: bytes.length,
          filePath,
        }).catch(() => undefined)
      }

      return {
        ...(ref !== undefined && inline
          ? {
            attachmentId: ref.attachmentId,
            mediaType: ref.mediaType,
            bytes: ref.bytes,
            width: ref.width,
            height: ref.height,
            ...(ref.name !== undefined ? { name: ref.name } : {}),
          }
          : {}),
        filePath,
      }
    },
  }))
}
