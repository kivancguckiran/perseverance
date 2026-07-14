import { timelineEventSchema } from '@persistent-codex/domain-events'
import { z } from 'zod'

const identifierSchema = z.string().min(1)
const sequenceSchema = z.number().int().nonnegative()
const sessionStatusSchema = z.enum(['starting', 'active', 'failed'])
export const approvalDecisionSchema = z.enum([
  'accept',
  'accept_for_session',
  'decline',
  'cancel',
])
export const approvalStatusSchema = z.enum([
  'pending',
  'resolving',
  'resolved',
  'expired',
  'superseded',
])
const scopeSchema = z.object({
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
})

export const subscribeMessageSchema = scopeSchema.extend({
  type: z.literal('subscribe'),
  afterSequence: sequenceSchema.default(0),
})

export const replayMessageSchema = scopeSchema.extend({
  type: z.literal('replay'),
  highWaterSequence: sequenceSchema,
  events: z.array(timelineEventSchema),
})

export const subscribedMessageSchema = scopeSchema.extend({
  type: z.literal('subscribed'),
  highWaterSequence: sequenceSchema,
})

export const eventMessageSchema = scopeSchema.extend({
  type: z.literal('event'),
  event: timelineEventSchema,
})

export const ackMessageSchema = scopeSchema.extend({
  type: z.literal('ack'),
  sequence: sequenceSchema,
})

export const errorMessageSchema = z.object({
  type: z.literal('error'),
  code: z.string().min(1),
  message: z.string().min(1),
})

export const approvalSchema = z.object({
  approvalId: identifierSchema,
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
  turnId: identifierSchema,
  itemId: identifierSchema,
  kind: z.enum(['command_execution', 'file_change']),
  status: approvalStatusSchema,
  context: z.record(z.string(), z.unknown()),
  availableDecisions: z.array(approvalDecisionSchema),
  requestedAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  resolvingUserId: z.string().nullable(),
  selectedDecision: approvalDecisionSchema.nullable(),
  version: z.number().int().positive(),
  upstreamResponseStatus: z.enum([
    'pending',
    'sent',
    'acknowledged',
    'unknown',
  ]),
})

export const approvalStateMessageSchema = z.object({
  type: z.literal('approval'),
  tenantId: identifierSchema,
  workspaceId: identifierSchema,
  sessionId: identifierSchema,
  approval: approvalSchema,
})

export const clientMessageSchema = z.discriminatedUnion('type', [
  subscribeMessageSchema,
  ackMessageSchema,
])

export const serverMessageSchema = z.discriminatedUnion('type', [
  replayMessageSchema,
  subscribedMessageSchema,
  eventMessageSchema,
  ackMessageSchema,
  errorMessageSchema,
  approvalStateMessageSchema,
])

export const replayResponseSchema = z.object({
  events: z.array(timelineEventSchema),
  highWaterSequence: sequenceSchema,
  nextAfterSequence: sequenceSchema,
  hasMore: z.boolean(),
})

export const createSessionRequestSchema = z.object({}).strict()

export const sessionResponseSchema = scopeSchema.extend({
  codexThreadId: identifierSchema.nullable(),
  status: sessionStatusSchema,
})

export const createTurnRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
})

export const turnAcceptedResponseSchema = scopeSchema.extend({
  codexThreadId: identifierSchema,
  codexTurnId: identifierSchema,
  idempotencyKey: identifierSchema,
})

export const approvalListResponseSchema = z.object({
  approvals: z.array(approvalSchema),
})
export const approvalDecisionRequestSchema = z.object({
  decision: approvalDecisionSchema,
  expectedVersion: z.number().int().positive(),
  clientContext: z
    .object({
      deviceId: z.string().min(1).optional(),
      reason: z.string().nullable(),
    })
    .optional(),
})

export const apiErrorResponseSchema = z.object({
  code: identifierSchema,
  message: identifierSchema,
  issues: z.array(z.string()).optional(),
})

export type SubscribeMessage = z.infer<typeof subscribeMessageSchema>
export type ReplayMessage = z.infer<typeof replayMessageSchema>
export type SubscribedMessage = z.infer<typeof subscribedMessageSchema>
export type EventMessage = z.infer<typeof eventMessageSchema>
export type AckMessage = z.infer<typeof ackMessageSchema>
export type ErrorMessage = z.infer<typeof errorMessageSchema>
export type ClientMessage = z.infer<typeof clientMessageSchema>
export type ServerMessage = z.infer<typeof serverMessageSchema>
export type ReplayResponse = z.infer<typeof replayResponseSchema>
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>
export type SessionResponse = z.infer<typeof sessionResponseSchema>
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>
export type TurnAcceptedResponse = z.infer<typeof turnAcceptedResponseSchema>
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>
export type Approval = z.infer<typeof approvalSchema>
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>
export type ApprovalDecisionRequest = z.infer<
  typeof approvalDecisionRequestSchema
>
