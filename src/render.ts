/**
 * Pure projection of an image_gen tool result into model-facing content.
 * Extracted from the plugin entry so tests can exercise it without a Host.
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AttachmentId, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface ImageGenResultValue {
  attachmentId?: unknown
  mediaType?: unknown
  bytes?: unknown
  width?: unknown
  height?: unknown
  name?: unknown
  filePath?: unknown
  url?: unknown
  markdown?: unknown
}

/**
 * Render a canonical `image_gen` result. An image block is emitted ONLY when
 * every attachment field is present and sane — an empty `attachmentId` or
 * zero dimensions would render a broken image in the Web UI, so those fall
 * back to text-only (the saved file path).
 */
export function renderImageResult(value: ImageGenResultValue): ContentBlock[] {
  const blocks: ContentBlock[] = []
  const id = value.attachmentId
  const mediaType = value.mediaType
  const bytes = value.bytes
  const width = value.width
  const height = value.height
  const ok = typeof id === 'string' && id.length > 0
    && typeof mediaType === 'string' && mediaType.length > 0
    && typeof bytes === 'number' && bytes > 0
    && typeof width === 'number' && width > 0
    && typeof height === 'number' && height > 0
  if (ok) {
    blocks.push({
      type: 'image',
      attachment: {
        attachmentId: id as AttachmentId,
        mediaType: mediaType as ImageMediaType,
        bytes,
        width,
        height,
        ...(typeof value.name === 'string' && value.name.length > 0 ? { name: value.name } : {}),
      },
    })
  }
  if (typeof value.url === 'string' && /^https?:\/\//.test(value.url)) {
    const markdown = typeof value.markdown === 'string' && value.markdown.length > 0
      ? value.markdown
      : `![image](${value.url})`
    blocks.push({ type: 'text', text: `嵌入叙述用：${markdown}` })
  } else if (typeof value.filePath === 'string' && value.filePath.length > 0) {
    blocks.push({ type: 'text', text: `Grok 生成的图片已保存到: ${value.filePath}` })
  }
  return blocks
}
