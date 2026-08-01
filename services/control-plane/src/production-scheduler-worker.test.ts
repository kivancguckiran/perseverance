import { mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PrepaidCreditError } from '@perseverance/billing-platform'
import {
  settleTerminalRunBilling,
  ensureConversationWorkspaceRoot,
  productionWorkspaceSandboxArgs,
  productionThreadStartParams,
  productionTurnCompletion,
  normalizeGeneratedConversationTitle,
  readWorkspaceEntry,
  shouldPersistProductionActivityNotification,
} from './production-scheduler-worker'

describe('production scheduler Codex boundary', () => {
  it('permits workspace writes without approval escalation', () => {
    expect(productionThreadStartParams('/workspace')).toEqual({
      cwd: '/workspace',
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
    })
  })

  it('maps folders to separate tenant-scoped homes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perseverance-homes-'))
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }
    const first = await ensureConversationWorkspaceRoot(
      root,
      scope,
      'fol_default',
    )
    const second = await ensureConversationWorkspaceRoot(
      root,
      scope,
      'fld_writing',
    )
    const otherTenant = await ensureConversationWorkspaceRoot(
      root,
      { ...scope, tenantId: 'tenant-b' },
      'fol_default',
    )
    expect(first).not.toBe(second)
    expect(first).not.toBe(otherTenant)
    await expect(
      ensureConversationWorkspaceRoot(root, scope, '../escape'),
    ).rejects.toThrow('INVALID_CONVERSATION_FOLDER_ID')
  })

  it('masks the shared root and binds only the selected folder', () => {
    const args = productionWorkspaceSandboxArgs({
      codexBin: '/app/codex/bin/codex.js',
      physicalWorkspace: '/workspace/.perseverance/home/fld_a',
      isolatedCodexHome: '/codex-home/runtime/run-a',
      sourceAuthFile: '/codex-home/auth.json',
    })
    expect(args).toContain('/scoped-workspace')
    expect(args).not.toContain('/workspace')
    expect(args).not.toContain('/')
    expect(args).not.toContain('--unshare-all')
    expect(args).toEqual(
      expect.arrayContaining([
        '--ro-bind',
        '/app/codex',
        '/app/codex',
        '--bind',
        '/workspace/.perseverance/home/fld_a',
        '/scoped-workspace',
      ]),
    )
    expect(args.at(-2)).toBe('/app/codex/bin/codex.js')
    expect(args.at(-1)).toBe('app-server')
  })
})

describe('production conversation metadata helpers', () => {
  it('normalizes a Luna title to one safe line', () => {
    expect(
      normalizeGeneratedConversationTitle('  **“Kalıcı Sohbet Başlıkları”**\n'),
    ).toBe('Kalıcı Sohbet Başlıkları')
  })

  it('reads scoped workspace files and rejects traversal and symlink escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'perseverance-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'perseverance-outside-'))
    await writeFile(join(root, 'index.md'), '# Başlık')
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(join(outside, 'secret.md'), join(root, 'escape.md'))

    await expect(readWorkspaceEntry(root, 'index.md')).resolves.toMatchObject({
      kind: 'file',
      path: 'index.md',
      content: '# Başlık',
    })
    await expect(readWorkspaceEntry(root, '../secret.md')).rejects.toThrow(
      'INVALID_WORKSPACE_PATH',
    )
    await expect(readWorkspaceEntry(root, 'escape.md')).rejects.toThrow(
      'WORKSPACE_PATH_ESCAPE',
    )
  })
})

describe('production scheduler activity capture', () => {
  it('keeps explicit summaries and command lifecycle events', () => {
    expect(
      shouldPersistProductionActivityNotification({
        method: 'item/agentMessage/delta',
        params: { delta: 'Mer' },
      }),
    ).toBe(true)
    expect(
      shouldPersistProductionActivityNotification({
        method: 'item/reasoning/summaryTextDelta',
        params: { delta: 'Checking the workspace' },
      }),
    ).toBe(true)
    expect(
      shouldPersistProductionActivityNotification({
        method: 'item/started',
        params: { item: { type: 'commandExecution' } },
      }),
    ).toBe(true)
  })

  it('never retains hidden reasoning text or duplicate agent messages', () => {
    expect(
      shouldPersistProductionActivityNotification({
        method: 'item/reasoning/textDelta',
        params: { delta: 'private reasoning' },
      }),
    ).toBe(false)
    expect(
      shouldPersistProductionActivityNotification({
        method: 'item/completed',
        params: { item: { type: 'agentMessage', text: 'done' } },
      }),
    ).toBe(false)
  })

  it('waits for turn completion and prefers the final snapshot message', () => {
    expect(
      productionTurnCompletion(
        {
          method: 'item/completed',
          params: { item: { type: 'agentMessage', text: 'Working…' } },
        },
        'Working…',
      ),
    ).toBeNull()
    expect(
      productionTurnCompletion(
        {
          method: 'turn/completed',
          params: {
            turn: {
              status: 'completed',
              items: [
                { id: 'msg-working', type: 'agentMessage', text: 'Working…' },
                { type: 'commandExecution', command: 'head -1 README.md' },
                {
                  id: 'msg-final',
                  type: 'agentMessage',
                  text: '# Perseverance',
                },
              ],
            },
          },
        },
        'Working…',
      ),
    ).toEqual({ text: '# Perseverance', itemId: 'msg-final' })
  })

  it('fails interrupted turns instead of returning an intermediate message', () => {
    expect(
      productionTurnCompletion(
        {
          method: 'turn/completed',
          params: {
            turn: {
              status: 'interrupted',
              error: { message: 'Turn interrupted by user' },
              items: [],
            },
          },
        },
        'Working…',
      ),
    ).toEqual({ error: 'CODEX_TURN_INTERRUPTED' })
  })
})

describe('production scheduler billing cleanup', () => {
  it('settles and releases admission for a terminal failed run', async () => {
    const billing = {
      settleOperation: vi.fn(async () => undefined),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await settleTerminalRunBilling(billing as never, scope, 'run-a', 'failed')

    expect(billing.settleOperation).toHaveBeenCalledWith(
      scope,
      'run-a',
      expect.objectContaining({
        idempotencyKey: 'wp26:run-a:failed',
        outcome: 'failed',
        terminal: true,
      }),
    )
    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-a')
  })

  it('releases admission when a non-prepaid run has no credit reservation', async () => {
    const billing = {
      settleOperation: vi.fn(async () => {
        throw new PrepaidCreditError('RESERVATION_NOT_FOUND')
      }),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await expect(
      settleTerminalRunBilling(
        billing as never,
        scope,
        'run-byok',
        'completed',
      ),
    ).resolves.toBeUndefined()

    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-byok')
  })

  it('releases admission but preserves real settlement failures', async () => {
    const settlementError = new PrepaidCreditError(
      'SETTLEMENT_EXCEEDS_RESERVATION',
    )
    const billing = {
      settleOperation: vi.fn(async () => {
        throw settlementError
      }),
      completeOperation: vi.fn(async () => undefined),
    }
    const scope = {
      tenantId: 'tenant-a',
      organizationId: 'organization-a',
      workspaceId: 'workspace-a',
    }

    await expect(
      settleTerminalRunBilling(billing as never, scope, 'run-bad', 'failed'),
    ).rejects.toBe(settlementError)

    expect(billing.completeOperation).toHaveBeenCalledWith(scope, 'run-bad')
  })
})
