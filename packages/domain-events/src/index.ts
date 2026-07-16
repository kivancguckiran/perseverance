import { z } from 'zod'

const eventIdentitySchema = z.object({
  eventId: z.string().min(1),
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1),
  workspaceId: z.string().min(1),
  sessionId: z.string().min(1),
  codexThreadId: z.string().min(1).optional(),
  codexTurnId: z.string().min(1).optional(),
  codexItemId: z.string().min(1).optional(),
  sequence: z.number().int().nonnegative(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
  source: z.enum([
    'codex-app-server',
    'claude-code',
    'gemini-cli',
    'cursor-agent',
  ]),
  sourceVersion: z.string().min(1),
  sourceMethod: z.string().min(1),
  visibility: z.enum(['user', 'operator', 'internal']),
})

function eventSchema<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return eventIdentitySchema.extend({ type: z.literal(type), payload })
}

const requestIdSchema = z.union([z.string(), z.number().int()])
const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.object({
    type: z.enum(['add', 'delete', 'update']),
    move_path: z.string().nullable().optional(),
  }),
  diff: z.string(),
})
const tokenUsageBreakdownSchema = z.object({
  totalTokens: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  reasoningOutputTokens: z.number().nonnegative(),
})
export const artifactPointerSchema = z.object({
  artifactId: z.string().min(1),
  startByte: z.number().int().nonnegative(),
  endByte: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
})
export const commandOutputStateSchema = z.object({
  previewTail: z.string(),
  previewByteLength: z.number().int().nonnegative(),
  truncated: z.boolean(),
  totalBytes: z.number().int().nonnegative(),
  artifact: artifactPointerSchema.nullable(),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
})

export const timelineEventSchema = z.discriminatedUnion('type', [
  eventSchema('turn.started', z.object({ status: z.string().min(1) })),
  eventSchema(
    'turn.completed',
    z.object({ status: z.string().min(1), errorCode: z.string().optional() }),
  ),
  eventSchema('agent.message.delta', z.object({ text: z.string() })),
  eventSchema('agent.message.completed', z.object({ text: z.string() })),
  eventSchema('reasoning.summary.delta', z.object({ text: z.string() })),
  eventSchema('plan.delta', z.object({ text: z.string() })),
  eventSchema('plan.completed', z.object({ text: z.string() })),
  eventSchema(
    'command.proposed',
    z.object({
      command: z.string(),
      cwd: z.string(),
      status: z.string().min(1),
    }),
  ),
  eventSchema(
    'command.output.delta',
    z.object({
      commandId: z.string().min(1),
      stream: z.enum(['stdout', 'stderr', 'combined']),
      chunkIndex: z.number().int().nonnegative(),
      byteLength: z.number().int().nonnegative(),
      text: z.string().max(65_536),
      truncated: z.boolean(),
      artifact: artifactPointerSchema.nullable(),
    }),
  ),
  eventSchema(
    'command.completed',
    z.object({
      command: z.string(),
      cwd: z.string(),
      status: z.string().min(1),
      output: commandOutputStateSchema,
      exitCode: z.number().int().nullable(),
      durationMs: z.number().nonnegative().nullable(),
    }),
  ),
  eventSchema(
    'file.change.proposed',
    z.object({
      status: z.string().min(1),
      changes: z.array(fileChangeSchema),
    }),
  ),
  eventSchema(
    'file.change.completed',
    z.object({
      status: z.string().min(1),
      changes: z.array(fileChangeSchema),
    }),
  ),
  eventSchema(
    'diff.updated',
    z.union([
      z.object({ diff: z.string() }),
      z.object({ changes: z.array(fileChangeSchema) }),
    ]),
  ),
  eventSchema(
    'tool.started',
    z.object({
      toolKind: z.enum(['mcp', 'dynamic']),
      tool: z.string().min(1),
      provider: z.string().nullable(),
      status: z.string().min(1),
      arguments: z.unknown(),
    }),
  ),
  eventSchema(
    'tool.completed',
    z.object({
      toolKind: z.enum(['mcp', 'dynamic']),
      tool: z.string().min(1),
      provider: z.string().nullable(),
      status: z.string().min(1),
      result: z.unknown(),
      error: z.string().nullable(),
      success: z.boolean().nullable(),
      durationMs: z.number().nonnegative().nullable(),
    }),
  ),
  eventSchema(
    'approval.requested',
    z.object({
      requestId: requestIdSchema,
      approvalId: z.string().nullable(),
      approvalKind: z.enum(['command', 'file']),
      reason: z.string().nullable(),
      command: z.string().nullable(),
      cwd: z.string().nullable(),
      grantRoot: z.string().nullable(),
    }),
  ),
  eventSchema(
    'approval.resolved',
    z.object({
      requestId: requestIdSchema,
      approvalKind: z.enum(['command', 'file', 'unknown']),
    }),
  ),
  eventSchema(
    'token.usage.updated',
    z.object({
      total: tokenUsageBreakdownSchema,
      last: tokenUsageBreakdownSchema,
      modelContextWindow: z.number().nonnegative().nullable(),
    }),
  ),
  eventSchema(
    'error.reported',
    z.object({
      message: z.string(),
      additionalDetails: z.string().nullable(),
      codexErrorInfo: z.unknown(),
      willRetry: z.boolean(),
    }),
  ),
  eventSchema('context.compacted', z.object({ itemId: z.string().nullable() })),
  eventSchema(
    'codex.unknown',
    z.object({
      envelopeKind: z.enum(['notification', 'request']),
      requestId: requestIdSchema.optional(),
      method: z.string(),
      params: z.unknown(),
    }),
  ),
  eventSchema(
    'provider.unknown',
    z.object({
      provider: z.enum(['claude', 'gemini', 'cursor']),
      eventType: z.string(),
      envelope: z.unknown(),
    }),
  ),
  eventSchema(
    'cursor.unknown',
    z.object({
      eventType: z.string(),
      envelope: z.unknown(),
    }),
  ),
])

export type TimelineEvent = z.infer<typeof timelineEventSchema>
export type TimelineEventType = TimelineEvent['type']

export function parseTimelineEvent(value: unknown): TimelineEvent {
  return timelineEventSchema.parse(value)
}
