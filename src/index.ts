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
import { assertUsableApiKey, LlmError } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import '@deepseek-ai/dsh-settings'
import { ImagineClient } from './client.js'
import { renderImageResult } from './render.js'
import { basename } from 'node:path'
import { logUsage, saveToAttachments, saveToDisk, resolveOutputDir } from './save.js'

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

interface AirpStage {
  markdownUrl(fileName: string): string | undefined
  mountRoot(dir: string): () => void
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
  let current = (): Config => config
  const read = (): Required<Pick<Config, 'baseURL' | 'apiKeyEnv' | 'proxy' | 'model' | 'outputDir' | 'usageLog'>> => {
    const value = current()
    return {
      baseURL: value.baseURL ?? DEFAULT_BASE_URL,
      apiKeyEnv: value.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
      proxy: value.proxy ?? DEFAULT_PROXY,
      model: value.model ?? DEFAULT_MODEL,
      outputDir: value.outputDir ?? DEFAULT_OUTPUT_DIR,
      usageLog: value.usageLog ?? true,
    }
  }

  const resolveApiKey = async (): Promise<string> => {
    const ref = credentialRef(read().apiKeyEnv)
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'dsh-grok-image', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) {
        return assertUsableApiKey(ambient.value, 'dsh-grok-image', ref)
      }
    }
    throw new LlmError(
      `dsh-grok-image: missing credential ${ref}; store it through the credentials service, or export it in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const client = new ImagineClient(() => {
    const next = read()
    return {
      baseURL: next.baseURL,
      model: next.model,
      ...next.proxy.length > 0 ? { proxy: next.proxy } : {},
    }
  })
  ctx.effect(() => () => client.dispose())
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, 'grok-image', Config, config, {
      setSource: (source: () => Config) => {
        current = source
      },
      onChange() {},
    })
  })

  // Optional AIRP host stage. When dsh-airp is mounted, hang the output
  // directory on /airp-media instead of owning a grok-specific route.
  let attached = false
  const attachStage = (stage: AirpStage) => {
    if (attached) return
    attached = true
    const root = resolveOutputDir(read().outputDir)
    ctx.effect(() => stage.mountRoot(root), 'dsh-grok-image: airpStage mountRoot')
  }
  const existingStage = ctx.get('airpStage') as AirpStage | undefined
  if (existingStage !== undefined) attachStage(existingStage)
  else {
    ctx.inject(['airpStage'], (inner) => {
      const stage = inner.get('airpStage') as AirpStage | undefined
      if (stage !== undefined) attachStage(stage)
    })
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
      const snapshot = read()
      const { bytes } = await client.generate(prompt, ratio, apiKey, exec.signal)

      if (exec.signal.aborted) {
        throw new Error('image_gen: cancelled after generation')
      }

      const filePath = await saveToDisk(snapshot.outputDir, bytes)

      if (exec.signal.aborted) {
        throw new Error('image_gen: cancelled after save')
      }

      const attachments = ctx.get('attachments')
      const ref = attachments !== undefined
        ? await saveToAttachments(attachments, bytes, filePath)
        : undefined

      const stage = ctx.get('airpStage') as AirpStage | undefined
      const url = stage?.markdownUrl(basename(filePath))

      if (snapshot.usageLog) {
        await logUsage(snapshot.outputDir, {
          model: snapshot.model,
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
        ...(url ? { url } : {}),
      }
    },
  }))
}
