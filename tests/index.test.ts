/**
 * Activation regression tests for the plugin entry.
 *
 * Nothing else in the suite reaches `src/index.ts`: the entry imports
 * `./client.js`, which Node's type stripping cannot resolve back to
 * `client.ts`, so these cases load the built `lib/index.js` — the artifact DSH
 * actually loads — and the `pretest` script rebuilds it first.
 *
 * They mount the plugin the way DSH's loader does: a real Cordis `Context`
 * with the real `tools` service, plus the exported `name` / `inject` / `Config`
 * / `apply`. Tool registration is otherwise unreachable from the test suite.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createVolatile } from '@deepseek-ai/cosmokit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Config, apply, inject, name } from '../lib/index.js'

/** Wait for the `tools` service to settle after mounting it. */
async function toolsContext(): Promise<Context> {
  const ctx = new Context()
  // `ToolRuntime` injects `systemPrompt`, so that service has to be mounted
  // first or the tools service never settles.
  ctx.plugin(SystemPrompt)
  ctx.plugin(ToolRuntime)
  for (let attempt = 0; attempt < 100 && ctx.get('tools') === undefined; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.notEqual(ctx.get('tools'), undefined, 'the tools service did not mount')
  return ctx
}

async function mount(ctx: Context, config: unknown) {
  const fiber = ctx.plugin({ name, inject, Config, apply, reusable: true }, config)
  assert.notEqual(fiber, undefined, 'the plugin fiber was not created')
  await fiber!.await()
  return fiber!
}

test('the plugin activates and registers the image_gen tool', async () => {
  const ctx = await toolsContext()
  await mount(ctx, {})

  const tool = ctx.tools.get('image_gen')
  assert.notEqual(tool, undefined, 'image_gen was not registered')
})

// Every field of `Config` is `.volatile()`, so the profile boot hands `apply`
// live `Volatile<T>` references rather than plain values. `ctx.plugin` cannot
// reproduce that: Cordis validates the raw config before `apply`, and a
// reference is not a string. This case calls `apply` directly with the shape
// app-boot really produces, so a read that forgets the reference surfaces here
// instead of on the user's first settings edit.
test('a config delivered as live references still activates', async () => {
  const ctx = await toolsContext()
  apply(ctx, {
    baseURL: createVolatile('https://cli-chat-proxy.grok.com/v1'),
    apiKeyEnv: createVolatile('GROK_SESSION_TOKEN'),
    proxy: createVolatile(''),
    model: createVolatile('grok-imagine-image-quality'),
    outputDir: createVolatile('~/grok-images'),
    usageLog: createVolatile(true),
  } as never)

  assert.notEqual(ctx.tools.get('image_gen'), undefined, 'image_gen was not registered')
})
