import { existsSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CodexTitleProcessRunner } from './title-process-runner'

const fixture = fileURLToPath(
  new URL('../test/fixtures/title-process-fixture.mjs', import.meta.url),
)
const input = (mode: string) => ({
  binary: process.execPath,
  args: [fixture, mode],
  codexHome: '/tmp',
  requestId: 'title:test',
})

describe('CodexTitleProcessRunner', () => {
  it('parses a bounded title and usage', async () => {
    await expect(
      new CodexTitleProcessRunner().run(input('success')),
    ).resolves.toMatchObject({
      title: 'Güvenli başlık',
      usage: { counters: { inputTokens: 4, outputTokens: 2 } },
    })
  })
  it('spawns in the platform temp directory without /private/tmp', async () => {
    const { title } = await new CodexTitleProcessRunner().run(input('cwd'))
    expect(title).toBe(realpathSync(tmpdir()))
    // Regression guard for on Linux hosts without a
    // /private/tmp -> /tmp symlink the runner must still work; the child
    // process above proves the spawn cwd is the platform tmpdir, not a
    // macOS-only hardcoded path.
    if (process.platform === 'linux' && !existsSync('/private/tmp'))
      expect(realpathSync(tmpdir()).startsWith('/private/')).toBe(false)
  })
  it('times out and kills a stuck process', async () => {
    await expect(
      new CodexTitleProcessRunner({
        timeoutMs: 25,
        maxStdoutBytes: 1024,
        maxStdoutLines: 10,
        killGraceMs: 10,
      }).run(input('timeout')),
    ).rejects.toThrow('timed out')
  })
  it('rejects excessive output lines', async () => {
    await expect(
      new CodexTitleProcessRunner({
        timeoutMs: 1000,
        maxStdoutBytes: 1024,
        maxStdoutLines: 2,
        killGraceMs: 10,
      }).run(input('lines')),
    ).rejects.toThrow('line limit')
  })
  it('rejects excessive stdout bytes', async () => {
    await expect(
      new CodexTitleProcessRunner({
        timeoutMs: 1000,
        maxStdoutBytes: 128,
        maxStdoutLines: 10,
        killGraceMs: 10,
      }).run(input('bytes')),
    ).rejects.toThrow('byte limit')
  })
})
