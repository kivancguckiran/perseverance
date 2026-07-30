import {
  timelineEventSchema,
  type TimelineEvent,
} from '@perseverance/domain-events'
import { z } from 'zod'

export const PROVIDER_CONTRACT_VERSION = 1 as const

const identifierSchema = z.string().min(1)
export const providerIdSchema = z.enum(['codex', 'claude', 'gemini', 'cursor'])
export const reasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
])
export const capabilitySupportSchema = z.enum([
  'supported',
  'unsupported',
  'degraded',
])
export const capabilityMatrixSchema = z.object({
  streaming: capabilitySupportSchema,
  reasoningSummary: capabilitySupportSchema,
  commandExecution: capabilitySupportSchema,
  fileChanges: capabilitySupportSchema,
  approvals: capabilitySupportSchema,
  interrupt: capabilitySupportSchema,
  resume: capabilitySupportSchema,
  toolCalls: capabilitySupportSchema,
  imageInput: capabilitySupportSchema,
  usage: capabilitySupportSchema.default('degraded'),
  cost: capabilitySupportSchema.default('degraded'),
})
export const providerIdentitySchema = z.object({
  provider: providerIdSchema,
  adapter: identifierSchema,
  adapterVersion: identifierSchema,
  upstreamVersion: identifierSchema,
})
export const providerModelSchema = z.object({
  provider: providerIdSchema,
  modelId: identifierSchema,
  displayName: identifierSchema,
  hidden: z.boolean(),
  isDefault: z.boolean(),
  reasoningEfforts: z.array(reasoningEffortSchema),
  defaultReasoningEffort: reasoningEffortSchema,
  inputModalities: z.array(z.string().min(1)),
  capabilities: capabilityMatrixSchema,
})
export const providerModelCatalogSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  identity: providerIdentitySchema,
  discoveredAt: z.iso.datetime(),
  models: z.array(providerModelSchema),
})

export const modelPolicyAliasSchema = z.enum(['sol', 'luna'])
export const modelPolicySchema = z.object({
  alias: modelPolicyAliasSchema,
  reasoningEffort: reasoningEffortSchema,
})
export const directModelSelectionSchema = z.object({
  modelId: identifierSchema,
  reasoningEffort: reasoningEffortSchema,
})
export const modelSelectionSchema = z.union([
  modelPolicySchema,
  directModelSelectionSchema,
])
export const modelAliasConfigSchema = z.record(
  modelPolicyAliasSchema,
  z.object({
    provider: providerIdSchema,
    selector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('model_id'), modelId: identifierSchema }),
      z.object({ kind: z.literal('catalog_default') }),
    ]),
  }),
)
export const resolvedModelPolicySchema = z.object({
  requested: modelSelectionSchema,
  provider: providerIdSchema,
  modelId: identifierSchema,
  reasoningEffort: reasoningEffortSchema,
  capabilitySnapshot: capabilityMatrixSchema,
  catalogDiscoveredAt: z.iso.datetime(),
})

export const DEFAULT_CONVERSATION_POLICY = {
  alias: 'sol',
  reasoningEffort: 'medium',
} as const
export const DEFAULT_TITLE_POLICY = {
  alias: 'luna',
  reasoningEffort: 'none',
} as const
export const DEFAULT_MODEL_ALIAS_CONFIG: ModelAliasConfig = {
  sol: { provider: 'codex', selector: { kind: 'catalog_default' } },
  luna: { provider: 'codex', selector: { kind: 'catalog_default' } },
}

export type ProviderId = z.infer<typeof providerIdSchema>
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>
export type CapabilityMatrix = z.infer<typeof capabilityMatrixSchema>
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>
export type ProviderModel = z.infer<typeof providerModelSchema>
export type ProviderModelCatalog = z.infer<typeof providerModelCatalogSchema>
export type ModelPolicy = z.infer<typeof modelPolicySchema>
export type ModelSelection = z.infer<typeof modelSelectionSchema>
export type ModelAliasConfig = z.infer<typeof modelAliasConfigSchema>
export type ResolvedModelPolicy = z.infer<typeof resolvedModelPolicySchema>

export class ProviderConfigurationError extends Error {
  readonly code:
    | 'MODEL_ALIAS_NOT_CONFIGURED'
    | 'MODEL_ALIAS_PROVIDER_MISMATCH'
    | 'MODEL_ALIAS_UNRESOLVED'
    | 'REASONING_EFFORT_UNSUPPORTED'
    | 'CURSOR_PERMISSION_POLICY_INVALID'
    | 'CURSOR_PERMISSION_POLICY_TOO_BROAD'

  constructor(code: ProviderConfigurationError['code'], message: string) {
    super(message)
    this.name = 'ProviderConfigurationError'
    this.code = code
  }
}

export function resolveModelPolicy(
  requestedInput: ModelPolicy,
  configInput: ModelAliasConfig,
  catalogInput: ProviderModelCatalog,
): ResolvedModelPolicy {
  const requested = modelPolicySchema.parse(requestedInput)
  const config = modelAliasConfigSchema.parse(configInput)
  const catalog = providerModelCatalogSchema.parse(catalogInput)
  const alias = config[requested.alias]
  if (!alias)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_NOT_CONFIGURED',
      `Configure providerModels.aliases.${requested.alias} before starting this operation`,
    )
  if (alias.provider !== catalog.identity.provider)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_PROVIDER_MISMATCH',
      `Alias ${requested.alias} targets ${alias.provider}, but the discovered catalog belongs to ${catalog.identity.provider}`,
    )
  const selector = alias.selector
  const model =
    selector.kind === 'model_id'
      ? catalog.models.find((entry) => entry.modelId === selector.modelId)
      : catalog.models.find((entry) => entry.isDefault && !entry.hidden)
  if (!model)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_UNRESOLVED',
      `Alias ${requested.alias} did not match the discovered ${alias.provider} model catalog; update providerModels.aliases.${requested.alias}`,
    )
  if (!model.reasoningEfforts.includes(requested.reasoningEffort))
    throw new ProviderConfigurationError(
      'REASONING_EFFORT_UNSUPPORTED',
      `Model selected by ${requested.alias} does not support reasoning effort ${requested.reasoningEffort}; choose one of ${model.reasoningEfforts.join(', ')}`,
    )
  return resolvedModelPolicySchema.parse({
    requested,
    provider: model.provider,
    modelId: model.modelId,
    reasoningEffort: requested.reasoningEffort,
    capabilitySnapshot: model.capabilities,
    catalogDiscoveredAt: catalog.discoveredAt,
  })
}

export function resolveModelSelection(
  provider: ProviderId,
  requestedInput: ModelSelection,
  configInput: ModelAliasConfig,
  catalogInput: ProviderModelCatalog,
): ResolvedModelPolicy {
  const requested = modelSelectionSchema.parse(requestedInput)
  const catalog = providerModelCatalogSchema.parse(catalogInput)
  if (catalog.identity.provider !== provider)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_PROVIDER_MISMATCH',
      `Requested provider ${provider}, but the discovered catalog belongs to ${catalog.identity.provider}`,
    )
  if ('alias' in requested)
    return resolveModelPolicy(requested, configInput, catalog)
  const model = catalog.models.find(
    (entry) => entry.modelId === requested.modelId && !entry.hidden,
  )
  if (!model)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_UNRESOLVED',
      `Model ${requested.modelId} is not present in the discovered ${provider} catalog; refresh the catalog or choose an available model`,
    )
  if (!model.reasoningEfforts.includes(requested.reasoningEffort))
    throw new ProviderConfigurationError(
      'REASONING_EFFORT_UNSUPPORTED',
      `Model ${requested.modelId} does not support reasoning effort ${requested.reasoningEffort}; choose one of ${model.reasoningEfforts.join(', ')}`,
    )
  return resolvedModelPolicySchema.parse({
    requested,
    provider,
    modelId: model.modelId,
    reasoningEffort: requested.reasoningEffort,
    capabilitySnapshot: model.capabilities,
    catalogDiscoveredAt: catalog.discoveredAt,
  })
}

export const sessionLifecycleSchema = z.enum([
  'starting',
  'active',
  'recovering',
  'recovery_required',
  'failed',
  'completed',
])
export const turnOutcomeSchema = z.enum([
  'in_progress',
  'completed',
  'failed',
  'interrupted',
])
export const providerSessionSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  provider: providerIdSchema,
  sessionId: identifierSchema,
  providerSessionId: identifierSchema.nullable(),
  lifecycle: sessionLifecycleSchema,
})
export const providerTurnSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  provider: providerIdSchema,
  sessionId: identifierSchema,
  turnId: identifierSchema,
  providerTurnId: identifierSchema.nullable(),
  outcome: turnOutcomeSchema,
})
export const providerInterruptSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  sessionId: identifierSchema,
  turnId: identifierSchema,
  reason: z.enum(['user', 'system']),
})
export const providerApprovalSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  approvalId: identifierSchema,
  sessionId: identifierSchema,
  turnId: identifierSchema,
  kind: z.enum(['command_execution', 'file_change', 'tool_call', 'network']),
  decisions: z.array(
    z.enum(['accept', 'accept_for_session', 'decline', 'cancel']),
  ),
})
export const providerApprovalResolutionSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  providerRequestId: z.union([identifierSchema, z.number().int()]),
  decision: z.enum(['accept', 'accept_for_session', 'decline', 'cancel']),
})
export const providerNormalizedEventSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  provider: providerIdSchema,
  rawEnvelopeChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  event: timelineEventSchema,
})
export interface ProviderNormalizedEvent {
  schemaVersion: typeof PROVIDER_CONTRACT_VERSION
  provider: ProviderId
  rawEnvelopeChecksum: string
  event: TimelineEvent
}

export const usageCountersSchema = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  cachedInputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  toolUnits: z.number().int().nonnegative().default(0),
})
export const usageReportSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  kind: z.enum(['delta', 'cumulative']),
  provider: providerIdSchema,
  requestId: identifierSchema,
  dedupeKey: identifierSchema,
  counters: usageCountersSchema,
  completeness: z.enum(['complete', 'partial']),
  occurredAt: z.iso.datetime(),
})
export const providerErrorSchema = z.object({
  schemaVersion: z.literal(PROVIDER_CONTRACT_VERSION),
  provider: providerIdSchema,
  code: z.enum([
    'unauthorized',
    'capacity_exhausted',
    'timeout',
    'rate_limited',
    'model_unavailable',
    'capability_unsupported',
    'invalid_request',
    'process_failed',
    'protocol_mismatch',
    'unknown',
  ]),
  message: z.string().min(1),
  retryable: z.boolean(),
  upstreamCode: z.string().min(1).nullable(),
})
export type UsageCounters = z.infer<typeof usageCountersSchema>
export type UsageReport = z.infer<typeof usageReportSchema>
export type ProviderError = z.infer<typeof providerErrorSchema>
export type ProviderInterrupt = z.infer<typeof providerInterruptSchema>
export type ProviderApprovalResolution = z.infer<
  typeof providerApprovalResolutionSchema
>

export interface ProviderTurnStartInput {
  sessionId: string | null
  prompt: string
  cwd: string
  modelId: string
  reasoningEffort: ReasoningEffort
  allowFileChanges?: boolean
}
export interface ProviderTurnStreamEvent {
  rawEnvelope: Record<string, unknown>
  normalized: ProviderNormalizedEvent
  usage?: UsageReport
  spill?: {
    data: Buffer
    stream: 'stdout' | 'stderr' | 'combined'
    chunkIndex: number
  }
}
export interface ProviderTurnTerminal {
  providerSessionId: string
  providerTurnId: string
  outcome: 'completed' | 'failed' | 'interrupted'
  usage?: UsageReport
  error?: ProviderError
}
export interface ProviderReadiness {
  ready: boolean
  version: string | null
  authReady: boolean | null
  authStatus: 'ready' | 'required' | 'unknown'
  code:
    | 'ready'
    | 'binary_missing'
    | 'binary_not_executable'
    | 'version_unparseable'
    | 'version_mismatch'
    | 'auth_required'
    | 'auth_unknown'
  instruction: string | null
}

export interface ProviderRuntimeAdapterV1 {
  readonly contractVersion: typeof PROVIDER_CONTRACT_VERSION
  readonly identity: ProviderIdentity
  discoverModelCatalog(): Promise<ProviderModelCatalog>
  normalizeEvent(input: unknown): ProviderNormalizedEvent
  interrupt(input: z.infer<typeof providerInterruptSchema>): Promise<void>
  resolveApproval(
    input: z.infer<typeof providerApprovalResolutionSchema>,
  ): Promise<void>
  checkReadiness?(): Promise<ProviderReadiness>
  startTurn?(
    input: ProviderTurnStartInput,
    onEvent: (event: ProviderTurnStreamEvent) => void | Promise<void>,
  ): Promise<ProviderTurnTerminal>
}

export const priceCatalogSchema = z.object({
  version: identifierSchema,
  currency: z.literal('USD'),
  effectiveAt: z.iso.datetime(),
  models: z.array(
    z.object({
      provider: providerIdSchema,
      modelId: identifierSchema,
      inputPerMillionMicros: z.number().int().nonnegative(),
      cachedInputPerMillionMicros: z.number().int().nonnegative(),
      outputPerMillionMicros: z.number().int().nonnegative(),
      reasoningPerMillionMicros: z.number().int().nonnegative(),
      toolUnitMicros: z.number().int().nonnegative(),
    }),
  ),
})
export type PriceCatalog = z.infer<typeof priceCatalogSchema>

export function estimateUsageCostMicros(input: {
  provider: ProviderId
  modelId: string
  counters: UsageCounters
  catalog: PriceCatalog
}): { amountMicros: number; priceCatalogVersion: string } {
  const counters = usageCountersSchema.parse(input.counters)
  const catalog = priceCatalogSchema.parse(input.catalog)
  const price = catalog.models.find(
    (entry) =>
      entry.provider === input.provider && entry.modelId === input.modelId,
  )
  if (!price)
    throw new ProviderConfigurationError(
      'MODEL_ALIAS_UNRESOLVED',
      `Price catalog ${catalog.version} has no price for ${input.provider}/${input.modelId}`,
    )
  const numerator =
    BigInt(counters.inputTokens) * BigInt(price.inputPerMillionMicros) +
    BigInt(counters.cachedInputTokens) *
      BigInt(price.cachedInputPerMillionMicros) +
    BigInt(counters.outputTokens) * BigInt(price.outputPerMillionMicros) +
    BigInt(counters.reasoningTokens) * BigInt(price.reasoningPerMillionMicros)
  const tokenCost = (numerator + 500_000n) / 1_000_000n
  const toolCost = BigInt(counters.toolUnits) * BigInt(price.toolUnitMicros)
  const total = tokenCost + toolCost
  if (total > BigInt(Number.MAX_SAFE_INTEGER))
    throw new RangeError('Estimated cost exceeds safe integer range')
  return { amountMicros: Number(total), priceCatalogVersion: catalog.version }
}

export interface ProviderCostReconciliationRequest {
  provider: ProviderId
  tenantId: string
  workspaceId: string
  sessionId: string
  turnId?: string
  from: string
  to: string
}
export interface ProviderCostReconciliationResult {
  sourceReference: string
  officialCostMicros: number
  currency: 'USD'
  reconciledAt: string
}
export interface ProviderCostReconciliationPort {
  reconcile(
    request: ProviderCostReconciliationRequest,
  ): Promise<ProviderCostReconciliationResult[]>
}

export class ProviderReconciliationError extends Error {
  readonly code:
    | 'PROVIDER_MISMATCH'
    | 'ADMIN_CREDENTIAL_REJECTED'
    | 'OFFICIAL_COST_UNAVAILABLE'
    | 'INVALID_OFFICIAL_COST_RESPONSE'

  constructor(
    code:
      | 'PROVIDER_MISMATCH'
      | 'ADMIN_CREDENTIAL_REJECTED'
      | 'OFFICIAL_COST_UNAVAILABLE'
      | 'INVALID_OFFICIAL_COST_RESPONSE',
    message: string,
  ) {
    super(message)
    this.name = 'ProviderReconciliationError'
    this.code = code
  }
}

function decimalUnitsToMicros(value: string | number, unitMicros: bigint) {
  const normalized = String(value)
  if (!/^\d+(?:\.\d+)?$/.test(normalized))
    throw new ProviderReconciliationError(
      'INVALID_OFFICIAL_COST_RESPONSE',
      'Official cost amount was not a non-negative decimal',
    )
  const [whole, fraction = ''] = normalized.split('.')
  const denominator = 10n ** BigInt(fraction.length)
  const numerator = BigInt(`${whole}${fraction}`) * unitMicros
  const rounded = (numerator + denominator / 2n) / denominator
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER))
    throw new ProviderReconciliationError(
      'INVALID_OFFICIAL_COST_RESPONSE',
      'Official cost amount exceeds the supported range',
    )
  return Number(rounded)
}

async function officialCostJson(
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
) {
  const response = await fetcher(url, { headers })
  if (response.status === 401 || response.status === 403)
    throw new ProviderReconciliationError(
      'ADMIN_CREDENTIAL_REJECTED',
      'Provider rejected the server-side admin/usage credential',
    )
  if (!response.ok)
    throw new ProviderReconciliationError(
      'OFFICIAL_COST_UNAVAILABLE',
      `Provider official cost endpoint returned HTTP ${response.status}`,
    )
  return response.json() as Promise<unknown>
}

export function createOpenAiCostReconciliationPort(input: {
  adminApiKey: string
  projectIds?: string[]
  apiKeyIds?: string[]
  fetcher?: typeof fetch
}): ProviderCostReconciliationPort {
  if (!input.adminApiKey.trim())
    throw new ProviderReconciliationError(
      'ADMIN_CREDENTIAL_REJECTED',
      'OpenAI admin API key is required',
    )
  const fetcher = input.fetcher ?? fetch
  return {
    async reconcile(request) {
      if (request.provider !== 'codex')
        throw new ProviderReconciliationError(
          'PROVIDER_MISMATCH',
          'OpenAI cost reconciliation only accepts Codex usage',
        )
      let page: string | undefined
      let pageCount = 0
      let officialCostMicros = 0
      do {
        const url = new URL('https://api.openai.com/v1/organization/costs')
        url.searchParams.set(
          'start_time',
          String(Math.floor(Date.parse(request.from) / 1000)),
        )
        url.searchParams.set(
          'end_time',
          String(Math.max(1, Math.ceil(Date.parse(request.to) / 1000))),
        )
        url.searchParams.set('limit', '180')
        for (const projectId of input.projectIds ?? [])
          url.searchParams.append('project_ids[]', projectId)
        for (const apiKeyId of input.apiKeyIds ?? [])
          url.searchParams.append('api_key_ids[]', apiKeyId)
        if (page) url.searchParams.set('page', page)
        const raw = (await officialCostJson(fetcher, url, {
          authorization: `Bearer ${input.adminApiKey}`,
          'content-type': 'application/json',
        })) as {
          data?: Array<{
            results?: Array<{ amount?: { value?: number; currency?: string } }>
          }>
          has_more?: boolean
          next_page?: string | null
        }
        for (const bucket of raw.data ?? [])
          for (const result of bucket.results ?? []) {
            if (result.amount?.currency?.toLowerCase() !== 'usd')
              throw new ProviderReconciliationError(
                'INVALID_OFFICIAL_COST_RESPONSE',
                'OpenAI official cost currency was not USD',
              )
            officialCostMicros += decimalUnitsToMicros(
              result.amount.value ?? Number.NaN,
              1_000_000n,
            )
          }
        pageCount += 1
        page = raw.has_more ? (raw.next_page ?? undefined) : undefined
        if (raw.has_more && !page)
          throw new ProviderReconciliationError(
            'INVALID_OFFICIAL_COST_RESPONSE',
            'OpenAI official cost pagination cursor was missing',
          )
      } while (page && pageCount < 100)
      if (page)
        throw new ProviderReconciliationError(
          'OFFICIAL_COST_UNAVAILABLE',
          'OpenAI official cost pagination exceeded the safety limit',
        )
      return [
        {
          sourceReference: `openai:organization-costs:${request.from}:${request.to}`,
          officialCostMicros,
          currency: 'USD',
          reconciledAt: new Date().toISOString(),
        },
      ]
    },
  }
}

export function createAnthropicCostReconciliationPort(input: {
  adminApiKey: string
  workspaceIds?: string[]
  fetcher?: typeof fetch
}): ProviderCostReconciliationPort {
  if (!input.adminApiKey.trim())
    throw new ProviderReconciliationError(
      'ADMIN_CREDENTIAL_REJECTED',
      'Anthropic admin API key is required',
    )
  const fetcher = input.fetcher ?? fetch
  return {
    async reconcile(request) {
      if (request.provider !== 'claude')
        throw new ProviderReconciliationError(
          'PROVIDER_MISMATCH',
          'Anthropic cost reconciliation only accepts Claude usage',
        )
      let page: string | undefined
      let pageCount = 0
      let officialCostMicros = 0
      do {
        const url = new URL(
          'https://api.anthropic.com/v1/organizations/cost_report',
        )
        url.searchParams.set('starting_at', request.from)
        url.searchParams.set('ending_at', request.to)
        url.searchParams.set('bucket_width', '1d')
        for (const workspaceId of input.workspaceIds ?? [])
          url.searchParams.append('workspace_ids[]', workspaceId)
        if (page) url.searchParams.set('page', page)
        const raw = (await officialCostJson(fetcher, url, {
          'x-api-key': input.adminApiKey,
          'anthropic-version': '2023-06-01',
          'user-agent': 'PersistentCodexWorkspace/phase2',
        })) as {
          data?: Array<{
            results?: Array<{ amount?: string; currency?: string }>
          }>
          has_more?: boolean
          next_page?: string | null
        }
        for (const bucket of raw.data ?? [])
          for (const result of bucket.results ?? []) {
            if (result.currency !== 'USD')
              throw new ProviderReconciliationError(
                'INVALID_OFFICIAL_COST_RESPONSE',
                'Anthropic official cost currency was not USD',
              )
            officialCostMicros += decimalUnitsToMicros(
              result.amount ?? 'invalid',
              10_000n,
            )
          }
        pageCount += 1
        page = raw.has_more ? (raw.next_page ?? undefined) : undefined
        if (raw.has_more && !page)
          throw new ProviderReconciliationError(
            'INVALID_OFFICIAL_COST_RESPONSE',
            'Anthropic official cost pagination cursor was missing',
          )
      } while (page && pageCount < 100)
      if (page)
        throw new ProviderReconciliationError(
          'OFFICIAL_COST_UNAVAILABLE',
          'Anthropic official cost pagination exceeded the safety limit',
        )
      return [
        {
          sourceReference: `anthropic:organization-costs:${request.from}:${request.to}`,
          officialCostMicros,
          currency: 'USD',
          reconciledAt: new Date().toISOString(),
        },
      ]
    },
  }
}
