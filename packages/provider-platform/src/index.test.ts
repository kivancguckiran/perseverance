import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONVERSATION_POLICY,
  ProviderConfigurationError,
  createAnthropicCostReconciliationPort,
  createOpenAiCostReconciliationPort,
  estimateUsageCostMicros,
  resolveModelPolicy,
  resolveModelSelection,
  type ProviderModelCatalog,
  type ProviderCostReconciliationPort,
} from './index'

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)),
      'utf8',
    ),
  )

const catalog: ProviderModelCatalog = {
  schemaVersion: 1,
  identity: {
    provider: 'codex',
    adapter: 'codex-app-server',
    adapterVersion: '1',
    upstreamVersion: 'fixture',
  },
  discoveredAt: '2026-07-15T00:00:00.000Z',
  models: [
    {
      provider: 'codex',
      modelId: 'fixture-model-a',
      displayName: 'Fixture A',
      hidden: false,
      isDefault: true,
      reasoningEfforts: ['none', 'medium'],
      defaultReasoningEffort: 'medium',
      inputModalities: ['text'],
      capabilities: {
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
    },
  ],
}

describe('provider model policy', () => {
  it('resolves aliases only through config and the discovered catalog', () => {
    expect(
      resolveModelPolicy(
        DEFAULT_CONVERSATION_POLICY,
        {
          sol: {
            provider: 'codex',
            selector: { kind: 'model_id', modelId: 'fixture-model-a' },
          },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      ),
    ).toMatchObject({
      provider: 'codex',
      modelId: 'fixture-model-a',
      reasoningEffort: 'medium',
    })
  })

  it('returns an actionable typed error for unresolved aliases', () => {
    expect(() =>
      resolveModelPolicy(
        DEFAULT_CONVERSATION_POLICY,
        {
          sol: {
            provider: 'codex',
            selector: { kind: 'model_id', modelId: 'missing' },
          },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      ),
    ).toThrow(ProviderConfigurationError)
    try {
      resolveModelPolicy(
        DEFAULT_CONVERSATION_POLICY,
        {
          sol: {
            provider: 'codex',
            selector: { kind: 'model_id', modelId: 'missing' },
          },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      )
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_ALIAS_UNRESOLVED' })
      expect(String(error)).toContain('providerModels.aliases.sol')
    }
  })

  it('validates direct provider/model/effort selections before runtime calls', () => {
    expect(
      resolveModelSelection(
        'codex',
        { modelId: 'fixture-model-a', reasoningEffort: 'none' },
        {
          sol: { provider: 'codex', selector: { kind: 'catalog_default' } },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      ),
    ).toMatchObject({
      requested: { modelId: 'fixture-model-a', reasoningEffort: 'none' },
      provider: 'codex',
      modelId: 'fixture-model-a',
    })
    expect(() =>
      resolveModelSelection(
        'claude',
        { modelId: 'fixture-model-a', reasoningEffort: 'none' },
        {
          sol: { provider: 'codex', selector: { kind: 'catalog_default' } },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      ),
    ).toThrow('Requested provider claude')
    expect(() =>
      resolveModelSelection(
        'codex',
        { modelId: 'fixture-model-a', reasoningEffort: 'xhigh' },
        {
          sol: { provider: 'codex', selector: { kind: 'catalog_default' } },
          luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
        },
        catalog,
      ),
    ).toThrow('choose one of none, medium')
  })
})

describe('deterministic pricing', () => {
  it('binds estimates to a price version and uses integer arithmetic', () => {
    expect(
      estimateUsageCostMicros({
        provider: 'codex',
        modelId: 'fixture-model-a',
        counters: {
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 250_000,
          reasoningTokens: 100_000,
          toolUnits: 2,
        },
        catalog: {
          version: 'fixture-2026-07-15',
          currency: 'USD',
          effectiveAt: '2026-07-15T00:00:00.000Z',
          models: [
            {
              provider: 'codex',
              modelId: 'fixture-model-a',
              inputPerMillionMicros: 1_000_000,
              cachedInputPerMillionMicros: 100_000,
              outputPerMillionMicros: 4_000_000,
              reasoningPerMillionMicros: 4_000_000,
              toolUnitMicros: 25_000,
            },
          ],
        },
      }),
    ).toEqual({
      amountMicros: 2_500_000,
      priceCatalogVersion: 'fixture-2026-07-15',
    })
  })
})

describe('provider-neutral reconciliation port', () => {
  it('accepts official-cost fixtures without credentials or content', async () => {
    const data = fixture('provider-cost-reconciliation.json')
    const port: ProviderCostReconciliationPort = {
      reconcile: async (request) => {
        expect(request).toEqual(data.request)
        return data.results
      },
    }
    const results = await port.reconcile(data.request)
    expect(results).toEqual(data.results)
    expect(JSON.stringify(data)).not.toMatch(
      /api.?key|bearer|prompt|model response|credential/i,
    )
  })

  it('maps OpenAI organization cost dollars with an admin-only credential', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                results: [{ amount: { value: 0.012345, currency: 'usd' } }],
              },
            ],
            has_more: false,
            next_page: null,
          }),
        ),
    )
    const result = await createOpenAiCostReconciliationPort({
      adminApiKey: 'admin-secret-fixture',
      projectIds: ['project-fixture'],
      fetcher: fetcher as unknown as typeof fetch,
    }).reconcile({
      provider: 'codex',
      tenantId: 'ten',
      workspaceId: 'wsp',
      sessionId: 'ses',
      turnId: 'turn',
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-15T00:01:00.000Z',
    })
    expect(result).toMatchObject([{ officialCostMicros: 12_345 }])
    const [url, init] = (
      fetcher as unknown as { mock: { calls: Array<[unknown, unknown]> } }
    ).mock.calls[0]!
    expect(String(url)).toContain('/v1/organization/costs')
    expect(String(url)).toContain('project_ids%5B%5D=project-fixture')
    expect(JSON.stringify(result)).not.toContain('admin-secret-fixture')
    expect(JSON.stringify(init)).toContain('admin-secret-fixture')
  })

  it('maps Anthropic fractional cents and paginates without exposing the key', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ results: [{ amount: '1.25', currency: 'USD' }] }],
            has_more: true,
            next_page: 'next-fixture',
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [{ results: [{ amount: '0.75', currency: 'USD' }] }],
            has_more: false,
            next_page: null,
          }),
        ),
      )
    const result = await createAnthropicCostReconciliationPort({
      adminApiKey: 'anthropic-admin-fixture',
      workspaceIds: ['workspace-fixture'],
      fetcher: fetcher as unknown as typeof fetch,
    }).reconcile({
      provider: 'claude',
      tenantId: 'ten',
      workspaceId: 'wsp',
      sessionId: 'ses',
      turnId: 'turn',
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-07-15T00:01:00.000Z',
    })
    expect(result).toMatchObject([{ officialCostMicros: 20_000 }])
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(
      String(
        (
          fetcher as unknown as {
            mock: { calls: Array<[unknown, unknown]> }
          }
        ).mock.calls[1]![0],
      ),
    ).toContain('page=next-fixture')
    expect(JSON.stringify(result)).not.toContain('anthropic-admin-fixture')
  })
})
