import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import semver from 'semver'

/**
 * Guards the manifest contract against the runtime, not just the tool logic.
 *
 * DSH mounts a bundle only when every `@deepseek-ai/dsh*` peerDependency of
 * its manifest satisfies the running dsh version. Two evaluators disagree on
 * pre-release versions, and both matter:
 *
 * - the loader's compatibility gate runs semver with prereleases included, so
 *   it happens to accept `^0.2.0-rc.2` on 0.2.1-rc.2;
 * - npm and pnpm run semver strictly, where `^0.2.0-rc.2` never covers
 *   0.2.1-rc.2 (a caret on a pre-release only admits pre-releases of the same
 *   major.minor.patch), so every install prints an unmet-peer warning.
 *
 * Encode the runtime lines this plugin claims to mount on and let the test
 * fail when a range stops covering one of them.
 */
const RUNTIME_LINES = ['0.2.0-rc.2', '0.2.1-rc.2'] as const

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as {
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** The packages whose version the loader compares against the running dsh. */
function harnessRanges(record: Record<string, string> | undefined): Array<[string, string]> {
  return Object.entries(record ?? {}).filter(
    ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
  )
}

test('every @deepseek-ai/dsh* peer range covers every supported runtime line', () => {
  const peers = harnessRanges(manifest.peerDependencies)
  assert.ok(peers.length > 0, 'the plugin must declare @deepseek-ai/dsh* peers')
  for (const [name, range] of peers) {
    for (const runtime of RUNTIME_LINES) {
      assert.ok(
        semver.satisfies(runtime, range),
        `${name} peer range "${range}" does not cover DSH ${runtime}`,
      )
    }
  }
})

test('devDependencies pin one harness release and that release is supported', () => {
  const dev = harnessRanges(manifest.devDependencies)
  assert.ok(dev.length > 0, 'the plugin must pin @deepseek-ai/dsh* devDependencies')
  const pinned = new Set(dev.map(([, range]) => range))
  assert.equal(pinned.size, 1, `harness devDependencies must pin one release, found ${[...pinned].join(', ')}`)
  const [pin] = [...pinned]
  assert.ok(pin !== undefined && semver.valid(pin) !== null, `harness devDependencies must pin an exact version, found "${pin}"`)
  assert.ok(
    RUNTIME_LINES.includes(pin as (typeof RUNTIME_LINES)[number]),
    `harness devDependencies pin "${pin}" is not one of the supported runtime lines ${RUNTIME_LINES.join(', ')}`,
  )
})
