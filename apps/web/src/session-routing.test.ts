import { createMemoryHistory, RouterProvider } from '@tanstack/react-router'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getRouter } from './router'
import { readSessionDetail } from './workspace-page'

const sessionResponse = {
  tenantId: 'ten_local',
  workspaceId: 'wsp_local',
  sessionId: 'route-param-test',
  title: 'Yeni konuşma',
  provider: 'codex',
  requestedPolicy: { alias: 'sol', reasoningEffort: 'medium' },
  resolvedModel: 'fixture-model',
  reasoningEffort: 'medium',
  capabilitySnapshot: {
    streaming: 'supported',
    reasoningSummary: 'supported',
    commandExecution: 'supported',
    fileChanges: 'supported',
    approvals: 'supported',
    interrupt: 'supported',
    resume: 'supported',
    toolCalls: 'supported',
    imageInput: 'unsupported',
  },
  codexThreadId: null,
  status: 'starting',
  recoveryErrorCode: null,
  lastResumedAt: null,
  runtimeGeneration: null,
  runtimeConnected: false,
  replay: { afterSequence: 0, highWaterSequence: 0 },
  recoveryOptions: [],
}

describe('session route integration', () => {
  it('passes the TanStack route param to WorkspacePage', async () => {
    const router = getRouter(
      createMemoryHistory({
        initialEntries: ['/sessions/route-param-test'],
      }),
    )
    await router.load()

    const markup = renderToStaticMarkup(
      createElement(RouterProvider, { router }),
    )

    expect(markup).toContain('data-session-id="route-param-test"')
  })

  it('requests the exact session detail URL for the route param', async () => {
    const fetcher = vi.fn(async () =>
      Response.json(sessionResponse, { status: 200 }),
    )

    await expect(
      readSessionDetail('route-param-test', fetcher),
    ).resolves.toMatchObject({ sessionId: 'route-param-test' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:3100/v1/sessions/route-param-test',
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('does not request session detail for the index route', async () => {
    const fetcher = vi.fn<typeof fetch>()

    await expect(readSessionDetail(undefined, fetcher)).resolves.toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
