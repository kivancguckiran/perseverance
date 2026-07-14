import { createHash, randomUUID } from 'node:crypto'
import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv'
import notificationSchema from '@persistent-codex/codex-protocol-generated/schemas/server-notification'
import requestSchema from '@persistent-codex/codex-protocol-generated/schemas/server-request'
import type {
  ServerNotification,
  ServerRequest,
} from '@persistent-codex/codex-protocol-generated'
import {
  parseTimelineEvent,
  type TimelineEvent,
} from '@persistent-codex/domain-events'

export interface EventAdapterContext {
  tenantId: string
  workspaceId: string
  sessionId: string
  sourceVersion: string
  nextSequence(): number
  now?(): Date
  nextEventId?(): string
}

export type RawCodexEnvelope = Record<string, unknown>
export type RedactionHook = (envelope: RawCodexEnvelope) => RawCodexEnvelope

export interface RawIngestResult {
  envelope: RawCodexEnvelope
  checksum: string
}

export interface AdaptedCodexEnvelope extends RawIngestResult {
  event: TimelineEvent
}

interface JsonSchemaUnion {
  definitions?: Record<string, unknown>
  oneOf?: Array<{
    properties?: { method?: { enum?: string[] } }
  }>
}

const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false })

function validatorsFromSchema(
  schema: JsonSchemaUnion,
): ReadonlyMap<string, ValidateFunction> {
  const validators = new Map<string, ValidateFunction>()
  for (const entry of schema.oneOf ?? []) {
    for (const method of entry.properties?.method?.enum ?? []) {
      validators.set(
        method,
        ajv.compile({ ...entry, definitions: schema.definitions }),
      )
    }
  }
  return validators
}

const notificationValidators = validatorsFromSchema(notificationSchema)
const requestValidators = validatorsFromSchema(requestSchema)
const sensitiveKey =
  /(?:authorization|api[-_]?key|access[-_]?token|bearer|password|secret)/i
const bearerValue = /\bbearer\s+\S+/i
const credentialValue = /\b(?:sk|sess)-[A-Za-z0-9_-]{8,}\b/
const redacted = '[REDACTED]'

function isRecord(value: unknown): value is RawCodexEnvelope {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function redactValue(value: unknown, key?: string): unknown {
  if (key && sensitiveKey.test(key)) return redacted
  if (
    typeof value === 'string' &&
    (bearerValue.test(value) || credentialValue.test(value))
  ) {
    return redacted
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item))
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, childKey),
    ]),
  )
}

export const defaultRedactionHook: RedactionHook = (envelope) =>
  redactValue(envelope) as RawCodexEnvelope

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(',')}}`
}

export function ingestRawCodexEnvelope(
  input: unknown,
  redact: RedactionHook = defaultRedactionHook,
): RawIngestResult {
  if (!isRecord(input)) {
    throw new CodexEnvelopeValidationError('Invalid JSON-RPC envelope')
  }

  const envelope = redact(structuredClone(input))
  if (!isRecord(envelope)) {
    throw new CodexEnvelopeValidationError(
      'Redaction hook must return a JSON-RPC object envelope',
    )
  }

  return {
    envelope,
    checksum: createHash('sha256')
      .update(canonicalJson(envelope))
      .digest('hex'),
  }
}

function formatValidationErrors(
  errors: ErrorObject[] | null | undefined,
): string {
  return (errors ?? [])
    .map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    )
    .join('; ')
}

export class CodexEnvelopeValidationError extends Error {
  readonly code = 'CODEX_ENVELOPE_VALIDATION_ERROR'
  readonly method?: string
  readonly issues: string

  constructor(message: string, method?: string, errors?: ErrorObject[] | null) {
    const issues = formatValidationErrors(errors)
    super(issues ? `${message}: ${issues}` : message)
    this.name = 'CodexEnvelopeValidationError'
    if (method !== undefined) this.method = method
    this.issues = issues
  }
}

function envelopeKind(envelope: RawCodexEnvelope): 'notification' | 'request' {
  if (typeof envelope.method !== 'string' || envelope.method.length === 0) {
    throw new CodexEnvelopeValidationError(
      'Invalid JSON-RPC envelope: method must be a non-empty string',
    )
  }
  if ('id' in envelope) {
    if (!(
      typeof envelope.id === 'string' ||
      (typeof envelope.id === 'number' && Number.isInteger(envelope.id))
    )) {
      throw new CodexEnvelopeValidationError(
        'Invalid JSON-RPC request envelope: id must be a string or integer',
        envelope.method,
      )
    }
    return 'request'
  }
  return 'notification'
}

function validateKnownEnvelope(
  envelope: RawCodexEnvelope,
  kind: 'notification' | 'request',
): ServerNotification | ServerRequest | undefined {
  const method = envelope.method as string
  const validate =
    kind === 'notification'
      ? notificationValidators.get(method)
      : requestValidators.get(method)
  if (!validate) return undefined
  if (!validate(envelope)) {
    const hasForwardCompatibleEnum = validate.errors?.some(
      (error) => error.keyword === 'enum' && error.instancePath !== '/method',
    )
    if (hasForwardCompatibleEnum) return undefined
    throw new CodexEnvelopeValidationError(
      `Invalid params for known Codex method ${method}`,
      method,
      validate.errors,
    )
  }
  return envelope as ServerNotification | ServerRequest
}

function requestKey(requestId: string | number): string {
  return `${typeof requestId}:${String(requestId)}`
}

function changesOf(
  changes: Array<{
    path: string
    kind:
      | { type: 'add' }
      | { type: 'delete' }
      | { type: 'update'; move_path: string | null }
    diff: string
  }>,
) {
  return changes.map(({ path, kind, diff }) => ({ path, kind, diff }))
}

export class CodexEventAdapter {
  readonly #context: EventAdapterContext
  readonly #redact: RedactionHook
  readonly #approvals = new Map<
    string,
    {
      kind: 'command' | 'file'
      turnId: string
      itemId: string
    }
  >()

  constructor(
    context: EventAdapterContext,
    options: { redact?: RedactionHook } = {},
  ) {
    this.#context = context
    this.#redact = options.redact ?? defaultRedactionHook
  }

  adapt(input: unknown): AdaptedCodexEnvelope {
    const raw = ingestRawCodexEnvelope(input, this.#redact)
    const kind = envelopeKind(raw.envelope)
    const known = validateKnownEnvelope(raw.envelope, kind)
    const event = known
      ? kind === 'notification'
        ? this.#adaptNotification(known as ServerNotification)
        : this.#adaptRequest(known as ServerRequest)
      : this.#event(raw.envelope.method as string, 'codex.unknown', {
          envelopeKind: kind,
          ...('id' in raw.envelope ? { requestId: raw.envelope.id } : {}),
          method: raw.envelope.method,
          params: raw.envelope.params,
        })

    return { ...raw, event }
  }

  #event(
    sourceMethod: string,
    type: TimelineEvent['type'],
    payload: unknown,
    identity: {
      codexThreadId?: string
      codexTurnId?: string
      codexItemId?: string
    } = {},
  ): TimelineEvent {
    const now = (this.#context.now?.() ?? new Date()).toISOString()
    return parseTimelineEvent({
      eventId: this.#context.nextEventId?.() ?? `evt_${randomUUID()}`,
      schemaVersion: 1,
      tenantId: this.#context.tenantId,
      workspaceId: this.#context.workspaceId,
      sessionId: this.#context.sessionId,
      sequence: this.#context.nextSequence(),
      occurredAt: now,
      receivedAt: now,
      source: 'codex-app-server',
      sourceVersion: this.#context.sourceVersion,
      sourceMethod,
      visibility: 'user',
      ...identity,
      type,
      payload,
    })
  }

  #adaptNotification(notification: ServerNotification): TimelineEvent {
    const method = notification.method
    switch (method) {
      case 'turn/started':
        return this.#event(
          method,
          'turn.started',
          {
            status: notification.params.turn.status,
          },
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turn.id,
          },
        )
      case 'turn/completed':
        return this.#event(
          method,
          'turn.completed',
          {
            status: notification.params.turn.status,
          },
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turn.id,
          },
        )
      case 'item/agentMessage/delta':
        return this.#event(
          method,
          'agent.message.delta',
          {
            text: notification.params.delta,
          },
          this.#itemIdentity(notification.params),
        )
      case 'item/reasoning/summaryTextDelta':
        return this.#event(
          method,
          'reasoning.summary.delta',
          {
            text: notification.params.delta,
          },
          this.#itemIdentity(notification.params),
        )
      case 'item/plan/delta':
        return this.#event(
          method,
          'plan.delta',
          {
            text: notification.params.delta,
          },
          this.#itemIdentity(notification.params),
        )
      case 'item/commandExecution/outputDelta':
        return this.#event(
          method,
          'command.output.delta',
          {
            commandId: notification.params.itemId,
            stream: 'combined',
            text: notification.params.delta,
          },
          this.#itemIdentity(notification.params),
        )
      case 'turn/diff/updated':
        return this.#event(
          method,
          'diff.updated',
          {
            diff: notification.params.diff,
          },
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turnId,
          },
        )
      case 'item/fileChange/patchUpdated':
        return this.#event(
          method,
          'diff.updated',
          {
            changes: changesOf(notification.params.changes),
          },
          this.#itemIdentity(notification.params),
        )
      case 'thread/tokenUsage/updated':
        return this.#event(
          method,
          'token.usage.updated',
          notification.params.tokenUsage,
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turnId,
          },
        )
      case 'error':
        return this.#event(
          method,
          'error.reported',
          {
            message: notification.params.error.message,
            additionalDetails: notification.params.error.additionalDetails,
            codexErrorInfo: notification.params.error.codexErrorInfo,
            willRetry: notification.params.willRetry,
          },
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turnId,
          },
        )
      case 'serverRequest/resolved': {
        const approval = this.#approvals.get(
          requestKey(notification.params.requestId),
        )
        this.#approvals.delete(requestKey(notification.params.requestId))
        return this.#event(
          method,
          'approval.resolved',
          {
            requestId: notification.params.requestId,
            approvalKind: approval?.kind ?? 'unknown',
          },
          {
            codexThreadId: notification.params.threadId,
            ...(approval
              ? { codexTurnId: approval.turnId, codexItemId: approval.itemId }
              : {}),
          },
        )
      }
      case 'thread/compacted':
        return this.#event(
          method,
          'context.compacted',
          { itemId: null },
          {
            codexThreadId: notification.params.threadId,
            codexTurnId: notification.params.turnId,
          },
        )
      case 'item/started':
      case 'item/completed':
        return this.#adaptItem(notification)
      default:
        return this.#event(method, 'codex.unknown', {
          envelopeKind: 'notification',
          method,
          params: notification.params,
        })
    }
  }

  #adaptItem(
    notification: Extract<
      ServerNotification,
      { method: 'item/started' | 'item/completed' }
    >,
  ): TimelineEvent {
    const { item, threadId, turnId } = notification.params
    const identity = {
      codexThreadId: threadId,
      codexTurnId: turnId,
      codexItemId: item.id,
    }
    const completed = notification.method === 'item/completed'

    switch (item.type) {
      case 'agentMessage':
        if (completed) {
          return this.#event(
            notification.method,
            'agent.message.completed',
            {
              text: item.text,
            },
            identity,
          )
        }
        break
      case 'plan':
        if (completed) {
          return this.#event(
            notification.method,
            'plan.completed',
            {
              text: item.text,
            },
            identity,
          )
        }
        break
      case 'commandExecution':
        return this.#event(
          notification.method,
          completed ? 'command.completed' : 'command.proposed',
          completed
            ? {
                command: item.command,
                cwd: item.cwd,
                status: item.status,
                output: item.aggregatedOutput,
                exitCode: item.exitCode,
                durationMs: item.durationMs,
              }
            : { command: item.command, cwd: item.cwd, status: item.status },
          identity,
        )
      case 'fileChange':
        return this.#event(
          notification.method,
          completed ? 'file.change.completed' : 'file.change.proposed',
          { status: item.status, changes: changesOf(item.changes) },
          identity,
        )
      case 'mcpToolCall':
        return this.#event(
          notification.method,
          completed ? 'tool.completed' : 'tool.started',
          completed
            ? {
                toolKind: 'mcp',
                tool: item.tool,
                provider: item.server,
                status: item.status,
                result: item.result,
                error: item.error?.message ?? null,
                success: item.status === 'completed',
                durationMs: item.durationMs,
              }
            : {
                toolKind: 'mcp',
                tool: item.tool,
                provider: item.server,
                status: item.status,
                arguments: item.arguments,
              },
          identity,
        )
      case 'dynamicToolCall':
        return this.#event(
          notification.method,
          completed ? 'tool.completed' : 'tool.started',
          completed
            ? {
                toolKind: 'dynamic',
                tool: item.tool,
                provider: item.namespace,
                status: item.status,
                result: item.contentItems,
                error:
                  item.status === 'failed' ? 'Dynamic tool call failed' : null,
                success: item.success,
                durationMs: item.durationMs,
              }
            : {
                toolKind: 'dynamic',
                tool: item.tool,
                provider: item.namespace,
                status: item.status,
                arguments: item.arguments,
              },
          identity,
        )
      case 'contextCompaction':
        if (completed) {
          return this.#event(
            notification.method,
            'context.compacted',
            {
              itemId: item.id,
            },
            identity,
          )
        }
        break
    }

    return this.#event(
      notification.method,
      'codex.unknown',
      {
        envelopeKind: 'notification',
        method: notification.method,
        params: notification.params,
      },
      identity,
    )
  }

  #adaptRequest(request: ServerRequest): TimelineEvent {
    switch (request.method) {
      case 'item/commandExecution/requestApproval': {
        const params = request.params
        this.#approvals.set(requestKey(request.id), {
          kind: 'command',
          turnId: params.turnId,
          itemId: params.itemId,
        })
        return this.#event(
          request.method,
          'approval.requested',
          {
            requestId: request.id,
            approvalId: params.approvalId ?? null,
            approvalKind: 'command',
            reason: params.reason ?? null,
            command: params.command ?? null,
            cwd: params.cwd ?? null,
            grantRoot: null,
          },
          this.#itemIdentity(params),
        )
      }
      case 'item/fileChange/requestApproval': {
        const params = request.params
        this.#approvals.set(requestKey(request.id), {
          kind: 'file',
          turnId: params.turnId,
          itemId: params.itemId,
        })
        return this.#event(
          request.method,
          'approval.requested',
          {
            requestId: request.id,
            approvalId: null,
            approvalKind: 'file',
            reason: params.reason ?? null,
            command: null,
            cwd: null,
            grantRoot: params.grantRoot ?? null,
          },
          this.#itemIdentity(params),
        )
      }
      default:
        return this.#event(request.method, 'codex.unknown', {
          envelopeKind: 'request',
          requestId: request.id,
          method: request.method,
          params: request.params,
        })
    }
  }

  #itemIdentity(params: { threadId: string; turnId: string; itemId: string }) {
    return {
      codexThreadId: params.threadId,
      codexTurnId: params.turnId,
      codexItemId: params.itemId,
    }
  }
}

export function adaptCodexNotification(
  notification: ServerNotification,
  context: EventAdapterContext,
): TimelineEvent {
  return new CodexEventAdapter(context).adapt(notification).event
}

export function adaptCodexServerRequest(
  request: ServerRequest,
  context: EventAdapterContext,
): TimelineEvent {
  return new CodexEventAdapter(context).adapt(request).event
}

export interface ReconciledItemSnapshot {
  key: string
  threadId: string
  turnId: string
  itemId: string
  completed: boolean
  event: TimelineEvent
  text?: string
  output?: string
}

function itemKey(event: TimelineEvent): string | undefined {
  if (!event.codexThreadId || !event.codexTurnId || !event.codexItemId) {
    return undefined
  }
  return JSON.stringify([
    event.codexThreadId,
    event.codexTurnId,
    event.codexItemId,
  ])
}

export class TimelineReconciler {
  readonly #items = new Map<string, ReconciledItemSnapshot>()

  apply(event: TimelineEvent): ReconciledItemSnapshot | undefined {
    const key = itemKey(event)
    if (!key) return undefined
    const previous = this.#items.get(key)
    if (previous?.completed) return previous

    const base = {
      key,
      threadId: event.codexThreadId as string,
      turnId: event.codexTurnId as string,
      itemId: event.codexItemId as string,
      event,
    }
    let next: ReconciledItemSnapshot

    switch (event.type) {
      case 'agent.message.delta':
      case 'plan.delta':
      case 'reasoning.summary.delta':
        next = {
          ...base,
          completed: false,
          text: `${previous?.text ?? ''}${event.payload.text}`,
        }
        break
      case 'command.output.delta':
        next = {
          ...base,
          completed: false,
          output: `${previous?.output ?? ''}${event.payload.text}`,
        }
        break
      case 'agent.message.completed':
      case 'plan.completed':
        next = { ...base, completed: true, text: event.payload.text }
        break
      case 'command.completed':
        next = {
          ...base,
          completed: true,
          output: event.payload.output ?? previous?.output ?? '',
        }
        break
      case 'file.change.completed':
      case 'tool.completed':
      case 'context.compacted':
        next = { ...base, completed: true }
        break
      default:
        next = { ...base, completed: false, ...previous }
    }

    this.#items.set(key, next)
    return next
  }

  get(threadId: string, turnId: string, itemId: string) {
    return this.#items.get(JSON.stringify([threadId, turnId, itemId]))
  }

  values(): ReconciledItemSnapshot[] {
    return [...this.#items.values()]
  }
}
