import { z } from 'zod'
import { deploymentProfileSchema } from '@persistent-codex/deployment-profiles'
import { providerIdSchema } from '@persistent-codex/provider-platform'

export const PROVIDER_AUTH_CONTRACT_VERSION = 1 as const

const id = z.string().trim().min(1).max(255)
const at = z.iso.datetime()

export const providerAuthModeSchema = z.enum([
  'subscription-oauth',
  'customer-api-key',
  'platform-credit',
  'local-cli-credential',
])
export type ProviderAuthMode = z.infer<typeof providerAuthModeSchema>

export const providerAuthEvidenceKindSchema = z.enum([
  'third-party-application-approval',
  'previously-approved',
  'customer-key-custody',
  'provider-terms-observation',
])
export type ProviderAuthEvidenceKind = z.infer<
  typeof providerAuthEvidenceKindSchema
>

export const providerAuthEvidenceSchema = z.object({
  evidenceVersion: z.number().int().positive(),
  kind: providerAuthEvidenceKindSchema,
  uri: z.url().refine((value) => value.startsWith('https://'), {
    message: 'evidence URI must use https',
  }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  observedAt: at,
  effectiveAt: at.nullable(),
})
export type ProviderAuthEvidence = z.infer<typeof providerAuthEvidenceSchema>

export const providerCapabilityDecisionKeySchema = z.object({
  provider: providerIdSchema,
  authMode: providerAuthModeSchema,
  deploymentProfile: deploymentProfileSchema,
  evidenceVersion: z.number().int().nonnegative(),
})
export type ProviderCapabilityDecisionKey = z.infer<
  typeof providerCapabilityDecisionKeySchema
>

export const providerCapabilityDecisionSchema =
  providerCapabilityDecisionKeySchema.extend({
    schemaVersion: z.literal(PROVIDER_AUTH_CONTRACT_VERSION),
    outcome: z.enum(['allow', 'deny']),
    reasonCode: id,
    actionableMessage: z.string().min(1).max(1_024),
    requiredEvidenceKind: providerAuthEvidenceKindSchema.nullable(),
  })
export type ProviderCapabilityDecision = z.infer<
  typeof providerCapabilityDecisionSchema
>

export const providerAuthProfileStateSchema = z.enum([
  'active',
  'expired',
  'revoked',
  'disconnected',
  'crypto-erased',
])
export type ProviderAuthProfileState = z.infer<
  typeof providerAuthProfileStateSchema
>

export const providerAuthScopeSchema = z.object({
  tenantId: id,
  organizationId: id,
  workspaceId: id,
})
export type ProviderAuthScope = z.infer<typeof providerAuthScopeSchema>

export const providerAuthProfileMetadataSchema = providerAuthScopeSchema.extend(
  {
    schemaVersion: z.literal(PROVIDER_AUTH_CONTRACT_VERSION),
    profileId: id,
    provider: providerIdSchema,
    authMode: providerAuthModeSchema,
    state: providerAuthProfileStateSchema,
    credentialVersion: z.number().int().positive(),
    expiresAt: at.nullable(),
    revokedAt: at.nullable(),
    disconnectedAt: at.nullable(),
    cryptoErasedAt: at.nullable(),
    version: z.number().int().positive(),
  },
)
export type ProviderAuthProfileMetadata = z.infer<
  typeof providerAuthProfileMetadataSchema
>

export const oauthFlowKindSchema = z.enum([
  'authorization-code-pkce',
  'device-code',
])
export type OAuthFlowKind = z.infer<typeof oauthFlowKindSchema>

export const oauthTransactionSchema = providerAuthScopeSchema.extend({
  schemaVersion: z.literal(PROVIDER_AUTH_CONTRACT_VERSION),
  transactionId: id,
  provider: providerIdSchema,
  flowKind: oauthFlowKindSchema,
  stateDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  pkceChallenge: z.string().min(43).max(128).nullable(),
  secretEnvelope: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'consumed', 'expired', 'revoked']),
  expiresAt: at,
  version: z.number().int().positive(),
})
export type OAuthTransaction = z.infer<typeof oauthTransactionSchema>

export const providerUsageLedgerEntrySchema = providerAuthScopeSchema.extend({
  schemaVersion: z.literal(PROVIDER_AUTH_CONTRACT_VERSION),
  usageId: id,
  provider: providerIdSchema,
  authMode: providerAuthModeSchema,
  billingMode: z.enum([
    'subscription-quota',
    'customer-api-billing',
    'platform-credit',
  ]),
  quantity: z.number().nonnegative(),
  unit: id,
  monetaryAmountMicros: z.number().int().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  estimated: z.boolean(),
  quotaLimit: z.number().nonnegative().nullable(),
  quotaRemaining: z.number().nonnegative().nullable(),
})
export type ProviderUsageLedgerEntry = z.infer<
  typeof providerUsageLedgerEntrySchema
>
