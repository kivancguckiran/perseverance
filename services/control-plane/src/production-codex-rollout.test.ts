import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  captureCodexRolloutSnapshot,
  loadProductionCodexRollout,
  productionCodexRolloutObjectKey,
  restoreCodexRolloutSnapshot,
  saveProductionCodexRollout,
} from './production-codex-rollout'
import { parseUserContentEnvelope } from './user-content-crypto'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

const scope = {
  tenantId: 'tenant-a',
  organizationId: 'organization-a',
  workspaceId: 'workspace-a',
}
const contentKey = {
  contentKey: Buffer.alloc(32, 7),
  keyVersion: 'key-v1',
}

describe('production Codex rollout snapshots', () => {
  it('round-trips rollout files without retaining provisioned credentials', async () => {
    const source = await mkdtemp(join(tmpdir(), 'codex-source-'))
    const restored = await mkdtemp(join(tmpdir(), 'codex-restored-'))
    roots.push(source, restored)
    await writeFile(join(source, 'auth.json'), 'secret')
    await writeFile(join(source, 'session_index.jsonl'), '{"id":"thr-a"}\n')
    await writeFile(join(source, '.codex-global-state.json'), '{"ok":true}')
    await writeFile(join(restored, 'auth.json'), 'different-secret')

    const snapshot = await captureCodexRolloutSnapshot(source)
    expect(new TextDecoder().decode(snapshot)).not.toContain('secret')
    await restoreCodexRolloutSnapshot(restored, snapshot)

    expect(await readFile(join(restored, 'session_index.jsonl'), 'utf8')).toBe(
      '{"id":"thr-a"}\n',
    )
    expect(await readFile(join(restored, 'auth.json'), 'utf8')).toBe(
      'different-secret',
    )
  })

  it('encrypts the scoped snapshot in object storage and restores it', async () => {
    const source = await mkdtemp(join(tmpdir(), 'codex-source-'))
    const restored = await mkdtemp(join(tmpdir(), 'codex-restored-'))
    roots.push(source, restored)
    await writeFile(join(source, 'history.jsonl'), 'patronun hikayesi')
    const objects = new Map<string, Uint8Array>()
    const objectStore = {
      put: async (key: string, body: Uint8Array) => {
        objects.set(key, body)
      },
      get: async (key: string) => {
        const value = objects.get(key)
        if (!value) throw new Error('OBJECT_GET_FAILED:404')
        return value
      },
    } as never

    await saveProductionCodexRollout({
      objectStore,
      scope,
      sessionId: 'session-a',
      codexHome: source,
      contentKey,
    })
    const stored = objects.get(
      productionCodexRolloutObjectKey(scope, 'session-a'),
    )!
    expect(parseUserContentEnvelope(stored)).not.toBeNull()
    expect(new TextDecoder().decode(stored)).not.toContain('patronun hikayesi')
    await expect(
      loadProductionCodexRollout({
        objectStore,
        scope,
        sessionId: 'session-a',
        codexHome: restored,
        contentKey,
      }),
    ).resolves.toBe(true)
    expect(await readFile(join(restored, 'history.jsonl'), 'utf8')).toBe(
      'patronun hikayesi',
    )
  })

  it('treats a missing legacy snapshot as a one-time fresh-thread migration', async () => {
    await expect(
      loadProductionCodexRollout({
        objectStore: {
          get: async () => {
            throw new Error('OBJECT_GET_FAILED:404')
          },
        } as never,
        scope,
        sessionId: 'legacy-session',
        codexHome: '/unused',
        contentKey,
      }),
    ).resolves.toBe(false)
  })

  it('rejects symlinks in server-owned rollout state', async () => {
    const source = await mkdtemp(join(tmpdir(), 'codex-source-'))
    roots.push(source)
    await symlink('/etc/passwd', join(source, 'escaped'))
    await expect(captureCodexRolloutSnapshot(source)).rejects.toThrow(
      'CODEX_ROLLOUT_SYMLINK_REJECTED',
    )
  })
})
