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
import type { AttachmentId, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { ImagineClient } from './client.js'
import { logUsage, saveToAttachments, saveToDisk } from './save.js'

export const name = 'grok-image'
export const inject = ['tools']

const DEFAULT_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const DEFAULT_PROXY = 'http://127.0.0.1:7890'
const DEFAULT_API_KEY_ENV = 'GROK_SESSION_TOKEN'
const DEFAULT_MODEL = 'grok-imagine-image-quality'
const DEFAULT_OUTPUT_DIR = '~/Workspace/grok-images'
const IMAGE_GEN_TIMEOUT_MS = 300_000

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
        description: 'Text description of the image to generate.',
      },
      aspect_ratio: {
        type: 'string',
        description: "Aspect ratio of the image: auto (default), 1:1, 16:9, 9:16, 3:2, 2:3. "
          + "1:1 for square (icons, profiles), 16:9 for wide (landscapes, cinematic), "
          + "9:16 for tall (phone wallpapers, stories), 3:2 for horizontal photos, "
          + "2:3 for vertical (portraits, posters).",
      },
    },
    timeoutMs: IMAGE_GEN_TIMEOUT_MS,
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        const blocks: ContentBlock[] = []
        const v = value as Record<string, unknown>
        if (typeof v.attachmentId === 'string' && typeof v.mediaType === 'string') {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: v.attachmentId as AttachmentId,
              mediaType: v.mediaType as ImageMediaType,
              bytes: typeof v.bytes === 'number' ? v.bytes : 0,
              width: typeof v.width === 'number' ? v.width : 0,
              height: typeof v.height === 'number' ? v.height : 0,
              ...(typeof v.name === 'string' ? { name: v.name } : {}),
            },
          })
        }
        if (typeof v.filePath === 'string') {
          blocks.push({ type: 'text', text: `Grok 生成的图片已保存到: ${v.filePath}` })
        }
        return blocks
      },
    },
    async execute(args) {
      const apiKey = await resolveApiKey()
      const client = new ImagineClient({
        baseURL: config.baseURL ?? DEFAULT_BASE_URL,
        apiKey,
        model,
        proxy: config.proxy ?? DEFAULT_PROXY,
      })

      const ratio = args.aspect_ratio ?? 'auto'
      const { bytes } = await client.generate(args.prompt, ratio)

      const filePath = await saveToDisk(outputDir, bytes)

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
        attachmentId: ref?.attachmentId ?? '',
        mediaType: ref?.mediaType ?? 'image/jpeg',
        bytes: ref?.bytes ?? bytes.length,
        width: ref?.width ?? 0,
        height: ref?.height ?? 0,
        ...(ref?.name !== undefined ? { name: ref.name } : {}),
        filePath,
      }
    },
  }))
}
