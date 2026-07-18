import {
  createHash,
  createHmac,
  createPublicKey,
  createVerify,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  type JsonWebKey,
} from 'node:crypto'
import {
  authPrincipalSchema,
  authorizationActionSchema,
  authorizationDecisionSchema,
  type AuthPrincipal,
  type AuthorizationAction,
  type AuthorizationDecision,
  type OrganizationMembership,
} from '@persistent-codex/control-plane-contracts'

export class AuthenticationError extends Error {
  readonly code: string
  constructor(code: string, message = 'Authentication failed') {
    super(message)
    this.code = code
    this.name = 'AuthenticationError'
  }
}

export interface AuthenticationRequest {
  authorization?: string
  headers: Record<string, string | string[] | undefined>
  now?: Date
}

export interface AuthenticationAdapter {
  authenticate(request: AuthenticationRequest): Promise<AuthPrincipal>
}

export const CORPUS_WORKLOAD_AUDIENCE =
  'urn:persistent-codex:workspace-corpus' as const
export type CorpusWorkloadAction = 'source.search' | 'citation.read'

interface WorkloadClaims {
  version: 1
  jti: string
  subject: string
  audience: typeof CORPUS_WORKLOAD_AUDIENCE
  tenantId: string
  organizationId: string
  workspaceId: string
  actions: CorpusWorkloadAction[]
  proofKeyHash: string
  issuedAt: number
  expiresAt: number
}

export interface IssuedCorpusWorkloadCredential {
  accessToken: string
  proofKey: string
  expiresAt: string
  credentialId: string
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url')
const proofKeyHash = (value: string) =>
  createHash('sha256').update(value).digest('base64url')

export class CorpusWorkloadCredentialAuthority {
  readonly #signingKey: Buffer
  readonly #audience: string
  readonly #maxTtlMs: number
  readonly #revoked = new Set<string>()
  readonly #nonces = new Map<string, number>()

  constructor(
    options: {
      signingKey?: Uint8Array
      audience?: string
      maxTtlMs?: number
    } = {},
  ) {
    this.#signingKey = Buffer.from(options.signingKey ?? randomBytes(32))
    if (this.#signingKey.byteLength < 32)
      throw new AuthenticationError('WORKLOAD_SIGNING_KEY_TOO_SHORT')
    this.#audience = options.audience ?? CORPUS_WORKLOAD_AUDIENCE
    this.#maxTtlMs = options.maxTtlMs ?? 5 * 60_000
  }

  issue(input: {
    tenantId: string
    organizationId: string
    workspaceId: string
    ttlMs?: number
    now?: Date
  }): IssuedCorpusWorkloadCredential {
    const now = input.now ?? new Date()
    const ttlMs = Math.min(input.ttlMs ?? 60_000, this.#maxTtlMs)
    if (ttlMs < 1_000) throw new AuthenticationError('WORKLOAD_TTL_INVALID')
    const proofKey = randomBytes(32).toString('base64url')
    const claims: WorkloadClaims = {
      version: 1,
      jti: randomUUID(),
      subject: `workspace-corpus:${input.workspaceId}`,
      audience: this.#audience as typeof CORPUS_WORKLOAD_AUDIENCE,
      tenantId: input.tenantId,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      actions: ['source.search', 'citation.read'],
      proofKeyHash: proofKeyHash(proofKey),
      issuedAt: now.getTime(),
      expiresAt: now.getTime() + ttlMs,
    }
    const payload = encode(claims)
    const signature = createHmac('sha256', this.#signingKey)
      .update(payload)
      .digest('base64url')
    return {
      accessToken: `pcw1.${payload}.${signature}`,
      proofKey,
      expiresAt: new Date(claims.expiresAt).toISOString(),
      credentialId: claims.jti,
    }
  }

  revoke(credentialId: string) {
    this.#revoked.add(credentialId)
  }

  verify(input: {
    authorization?: string
    proof?: string
    timestamp?: string
    nonce?: string
    action: CorpusWorkloadAction
    tenantId: string
    organizationId: string
    workspaceId: string
    now?: Date
  }): AuthPrincipal {
    const token = input.authorization?.match(/^Bearer (pcw1\.[^\s]+)$/)?.[1]
    if (!token) throw new AuthenticationError('WORKLOAD_AUTH_REQUIRED')
    const [, payload, signature] = token.split('.')
    if (!payload || !signature)
      throw new AuthenticationError('WORKLOAD_TOKEN_MALFORMED')
    const expected = createHmac('sha256', this.#signingKey)
      .update(payload)
      .digest('base64url')
    if (!constantTimeEqual(signature, expected))
      throw new AuthenticationError('WORKLOAD_TOKEN_SIGNATURE_INVALID')
    let claims: WorkloadClaims
    try {
      claims = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as WorkloadClaims
    } catch {
      throw new AuthenticationError('WORKLOAD_TOKEN_MALFORMED')
    }
    const now = input.now ?? new Date()
    const timestamp = Number(input.timestamp)
    if (
      claims.version !== 1 ||
      claims.audience !== this.#audience ||
      claims.expiresAt <= now.getTime() ||
      claims.issuedAt > now.getTime() + 5_000 ||
      this.#revoked.has(claims.jti)
    )
      throw new AuthenticationError('WORKLOAD_TOKEN_REJECTED')
    if (
      claims.tenantId !== input.tenantId ||
      claims.organizationId !== input.organizationId ||
      claims.workspaceId !== input.workspaceId ||
      !claims.actions.includes(input.action)
    )
      throw new AuthenticationError('WORKLOAD_SCOPE_REJECTED')
    if (
      !input.nonce ||
      input.nonce.length > 128 ||
      !Number.isFinite(timestamp) ||
      Math.abs(now.getTime() - timestamp) > 30_000 ||
      !input.proof
    )
      throw new AuthenticationError('WORKLOAD_PROOF_REQUIRED')
    for (const [nonce, expiresAt] of this.#nonces)
      if (expiresAt <= now.getTime()) this.#nonces.delete(nonce)
    const replayKey = `${claims.jti}:${input.nonce}`
    if (this.#nonces.has(replayKey))
      throw new AuthenticationError('WORKLOAD_REPLAY_REJECTED')
    const proofKey = input.proof.split('.')[0]
    const proofSignature = input.proof.split('.')[1]
    if (
      !proofKey ||
      !proofSignature ||
      proofKeyHash(proofKey) !== claims.proofKeyHash
    )
      throw new AuthenticationError('WORKLOAD_PROOF_INVALID')
    const proofMessage = [
      token,
      input.timestamp,
      input.nonce,
      input.action,
    ].join('\n')
    const expectedProof = createHmac('sha256', proofKey)
      .update(proofMessage)
      .digest('base64url')
    if (!constantTimeEqual(proofSignature, expectedProof))
      throw new AuthenticationError('WORKLOAD_PROOF_INVALID')
    this.#nonces.set(replayKey, claims.expiresAt)
    return authPrincipalSchema.parse({
      version: 1,
      kind: 'internal_service',
      subject: claims.subject,
      issuer: 'urn:persistent-codex:workload',
      audience: [claims.audience],
      authenticatedAt: new Date(claims.issuedAt).toISOString(),
      expiresAt: new Date(claims.expiresAt).toISOString(),
      assurance: { level: 'workload-proof-v1', mfa: false },
      memberships: [],
    })
  }
}

export interface MembershipDirectory {
  membershipsFor(subject: string, issuer: string): OrganizationMembership[]
}

export class StaticMembershipDirectory implements MembershipDirectory {
  readonly #memberships: OrganizationMembership[]
  constructor(memberships: OrganizationMembership[]) {
    this.#memberships = memberships
  }
  membershipsFor(subject: string, issuer: string) {
    return this.#memberships.filter(
      (membership) =>
        membership.subject === subject && membership.issuer === issuer,
    )
  }
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

export class ExplicitDevAuthenticationAdapter implements AuthenticationAdapter {
  readonly issuer: string
  readonly subject: string
  constructor(options: { issuer?: string; subject?: string } = {}) {
    this.issuer = options.issuer ?? 'urn:persistent-codex:dev-auth'
    this.subject = options.subject ?? 'dev-user'
  }
  async authenticate(request: AuthenticationRequest) {
    const organizationId = firstHeader(request.headers['x-tenant-id'])
    const workspaceId = firstHeader(request.headers['x-workspace-id'])
    if (!organizationId || !workspaceId)
      throw new AuthenticationError('AUTH_REQUIRED')
    const now = request.now ?? new Date()
    return authPrincipalSchema.parse({
      version: 1,
      kind: 'end_user',
      subject: this.subject,
      issuer: this.issuer,
      audience: ['persistent-codex-local'],
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
      assurance: { level: 'dev', mfa: false },
      memberships: [
        {
          version: 1,
          subject: this.subject,
          issuer: this.issuer,
          organizationId,
          role: 'owner',
          status: 'active',
          workspaceIds: [workspaceId],
          updatedAt: now.toISOString(),
        },
      ],
    })
  }
}

export interface OidcAuthenticationOptions {
  issuer: string
  audience: string
  algorithms?: Array<'RS256'>
  jwksTtlMs?: number
  maxJwksKeys?: number
  fetcher?: typeof fetch
  discoveryUrl?: string
}

interface CachedJwks {
  expiresAt: number
  jwksUri: string
  keys: JsonWebKey[]
}

function decodePart(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
  } catch {
    throw new AuthenticationError('TOKEN_MALFORMED')
  }
}

function claimString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value) throw new AuthenticationError(code)
  return value
}

function audienceMatches(value: unknown, expected: string): boolean {
  return typeof value === 'string'
    ? value === expected
    : Array.isArray(value) &&
        value.every((item) => typeof item === 'string') &&
        value.includes(expected)
}

export class OidcAuthenticationAdapter implements AuthenticationAdapter {
  readonly #options: Required<
    Pick<
      OidcAuthenticationOptions,
      'issuer' | 'audience' | 'jwksTtlMs' | 'maxJwksKeys'
    >
  > &
    Omit<OidcAuthenticationOptions, 'jwksTtlMs' | 'maxJwksKeys'>
  #cache?: CachedJwks
  constructor(options: OidcAuthenticationOptions) {
    this.#options = {
      ...options,
      algorithms: options.algorithms ?? ['RS256'],
      jwksTtlMs: options.jwksTtlMs ?? 5 * 60_000,
      maxJwksKeys: options.maxJwksKeys ?? 16,
      fetcher: options.fetcher ?? fetch,
    }
  }
  async #keys(now: number, force = false): Promise<CachedJwks> {
    if (!force && this.#cache && this.#cache.expiresAt > now) return this.#cache
    try {
      const discoveryUrl =
        this.#options.discoveryUrl ??
        `${this.#options.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
      const discovery = (await (
        await this.#options.fetcher!(discoveryUrl, { cache: 'no-store' })
      ).json()) as { issuer?: unknown; jwks_uri?: unknown }
      if (discovery.issuer !== this.#options.issuer)
        throw new AuthenticationError('OIDC_DISCOVERY_ISSUER_MISMATCH')
      const jwksUri = claimString(discovery.jwks_uri, 'OIDC_JWKS_URI_MISSING')
      const response = await this.#options.fetcher!(jwksUri, {
        cache: 'no-store',
      })
      if (!response.ok) throw new AuthenticationError('OIDC_JWKS_UNAVAILABLE')
      const value = (await response.json()) as { keys?: unknown }
      if (!Array.isArray(value.keys))
        throw new AuthenticationError('OIDC_JWKS_INVALID')
      const keys = value.keys
        .filter(
          (key): key is JsonWebKey =>
            Boolean(key) &&
            typeof key === 'object' &&
            typeof (key as JsonWebKey).kid === 'string',
        )
        .slice(0, this.#options.maxJwksKeys)
      if (!keys.length) throw new AuthenticationError('OIDC_JWKS_EMPTY')
      this.#cache = {
        expiresAt: now + this.#options.jwksTtlMs,
        jwksUri,
        keys,
      }
      return this.#cache
    } catch (error) {
      if (error instanceof AuthenticationError) throw error
      throw new AuthenticationError('OIDC_JWKS_UNAVAILABLE')
    }
  }
  async authenticate(request: AuthenticationRequest) {
    const token = request.authorization?.match(/^Bearer ([^\s]+)$/)?.[1]
    if (!token) throw new AuthenticationError('AUTH_REQUIRED')
    const parts = token.split('.')
    if (parts.length !== 3) throw new AuthenticationError('TOKEN_MALFORMED')
    const header = decodePart(parts[0]!) as {
      alg?: unknown
      kid?: unknown
      typ?: unknown
    }
    if (
      header.alg === 'none' ||
      !this.#options.algorithms?.includes(header.alg as never)
    )
      throw new AuthenticationError('TOKEN_ALGORITHM_REJECTED')
    const kid = claimString(header.kid, 'TOKEN_KEY_ID_MISSING')
    const now = request.now ?? new Date()
    let cache = await this.#keys(now.getTime())
    let key = cache.keys.find((candidate) => candidate.kid === kid)
    if (!key) {
      cache = await this.#keys(now.getTime(), true)
      key = cache.keys.find((candidate) => candidate.kid === kid)
    }
    if (!key) throw new AuthenticationError('TOKEN_KEY_UNKNOWN')
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${parts[0]}.${parts[1]}`)
    verifier.end()
    if (
      !verifier.verify(
        createPublicKey({ key, format: 'jwk' }),
        Buffer.from(parts[2]!, 'base64url'),
      )
    )
      throw new AuthenticationError('TOKEN_SIGNATURE_INVALID')
    const claims = decodePart(parts[1]!) as Record<string, unknown>
    if (claims.iss !== this.#options.issuer)
      throw new AuthenticationError('TOKEN_ISSUER_INVALID')
    if (!audienceMatches(claims.aud, this.#options.audience))
      throw new AuthenticationError('TOKEN_AUDIENCE_INVALID')
    const exp = Number(claims.exp)
    const nbf = claims.nbf === undefined ? undefined : Number(claims.nbf)
    const authTime =
      claims.auth_time === undefined
        ? Number(claims.iat)
        : Number(claims.auth_time)
    const seconds = Math.floor(now.getTime() / 1000)
    if (!Number.isFinite(exp) || exp <= seconds)
      throw new AuthenticationError('TOKEN_EXPIRED')
    if (nbf !== undefined && (!Number.isFinite(nbf) || nbf > seconds))
      throw new AuthenticationError('TOKEN_NOT_ACTIVE')
    if (!Number.isFinite(authTime) || authTime > seconds)
      throw new AuthenticationError('TOKEN_AUTH_TIME_INVALID')
    const subject = claimString(claims.sub, 'TOKEN_SUBJECT_MISSING')
    const amr = Array.isArray(claims.amr)
      ? claims.amr.filter((value): value is string => typeof value === 'string')
      : []
    return authPrincipalSchema.parse({
      version: 1,
      kind: 'end_user',
      subject,
      issuer: this.#options.issuer,
      audience: Array.isArray(claims.aud) ? claims.aud : [claims.aud],
      authenticatedAt: new Date(authTime * 1000).toISOString(),
      expiresAt: new Date(exp * 1000).toISOString(),
      assurance: {
        level:
          typeof claims.acr === 'string'
            ? claims.acr.slice(0, 128)
            : amr.length
              ? 'amr'
              : 'unspecified',
        mfa: amr.includes('mfa'),
      },
      memberships: [],
    })
  }
}

export interface AuthorizationResource {
  organizationId: string
  workspaceId?: string
  sessionId?: string
  resourceType: string
  resourceId?: string
}

const ROLE_ACTIONS: Record<OrganizationMembership['role'], Set<string>> = {
  owner: new Set(['*']),
  admin: new Set([
    'session.read',
    'session.create',
    'session.update',
    'turn.start',
    'turn.interrupt',
    'turn.steer',
    'workspace.snapshot.read',
    'usage.read',
    'usage.reconcile',
    'audit.read',
    'metrics.read',
    'folder.read',
    'folder.manage',
    'provider.catalog.read',
    'provider.readiness.read',
    'source.create',
    'source.read',
    'source.delete',
    'source.reindex',
    'source.search',
    'citation.read',
    'notification.subscribe',
    'notification.read',
    'notification.revoke',
    'support.grant.read',
    'support.grant.approve',
    'break_glass.approve',
  ]),
  developer: new Set([
    'session.read',
    'session.create',
    'session.update',
    'turn.start',
    'turn.interrupt',
    'turn.steer',
    'event.replay',
    'event.subscribe',
    'approval.read',
    'approval.decide',
    'notification.subscribe',
    'notification.read',
    'notification.revoke',
    'attachment.upload',
    'attachment.read',
    'attachment.delete',
    'artifact.metadata.read',
    'artifact.read',
    'artifact.download',
    'workspace.snapshot.read',
    'usage.read',
    'audit.read',
    'folder.read',
    'folder.manage',
    'provider.catalog.read',
    'provider.readiness.read',
    'source.create',
    'source.read',
    'source.delete',
    'source.reindex',
    'source.search',
    'citation.read',
    'support.grant.create',
    'support.grant.read',
    'support.grant.revoke',
  ]),
  viewer: new Set([
    'session.read',
    'event.replay',
    'event.subscribe',
    'approval.read',
    'notification.subscribe',
    'notification.read',
    'notification.revoke',
    'attachment.read',
    'artifact.metadata.read',
    'artifact.read',
    'artifact.download',
    'workspace.snapshot.read',
    'usage.read',
    'audit.read',
    'folder.read',
    'provider.catalog.read',
    'provider.readiness.read',
    'source.read',
    'source.search',
    'citation.read',
    'support.grant.create',
    'support.grant.read',
    'support.grant.revoke',
  ]),
  billing: new Set(['usage.read', 'usage.reconcile', 'audit.read']),
  support: new Set([
    'session.read',
    'support.grant.read',
    'support.grant.approve',
    'support.access.use',
  ]),
  operator: new Set([
    'metrics.read',
    'provider.readiness.read',
    'support.grant.read',
    'break_glass.request',
  ]),
  security_approver: new Set([
    'support.grant.read',
    'support.grant.approve',
    'break_glass.approve',
  ]),
  kms_operator: new Set([
    'support.grant.read',
    'support.grant.approve',
    'support.access.use',
    'break_glass.approve',
  ]),
}

export function authorize(input: {
  principal: AuthPrincipal
  action: string
  resource?: AuthorizationResource
  memberships: OrganizationMembership[]
}): AuthorizationDecision {
  const parsedAction = authorizationActionSchema.safeParse(input.action)
  if (!parsedAction.success)
    return authorizationDecisionSchema.parse({
      version: 1,
      allow: false,
      reasonCode: 'UNKNOWN_ACTION',
    })
  if (!input.resource?.organizationId || !input.resource.resourceType)
    return authorizationDecisionSchema.parse({
      version: 1,
      allow: false,
      reasonCode: 'RESOURCE_SCOPE_MISSING',
    })
  if (input.principal.kind !== 'end_user')
    return authorizationDecisionSchema.parse({
      version: 1,
      allow: false,
      reasonCode: 'PRINCIPAL_KIND_MISMATCH',
    })
  const membership = input.memberships.find(
    (candidate) =>
      candidate.organizationId === input.resource!.organizationId &&
      candidate.subject === input.principal.subject &&
      candidate.issuer === input.principal.issuer,
  )
  if (!membership || membership.status !== 'active')
    return authorizationDecisionSchema.parse({
      version: 1,
      allow: false,
      reasonCode: 'MEMBERSHIP_INACTIVE',
    })
  if (
    input.resource.workspaceId &&
    membership.workspaceIds.length > 0 &&
    !membership.workspaceIds.includes(input.resource.workspaceId)
  )
    return authorizationDecisionSchema.parse({
      version: 1,
      allow: false,
      reasonCode: 'WORKSPACE_MEMBERSHIP_MISSING',
    })
  const actions = ROLE_ACTIONS[membership.role]!
  return authorizationDecisionSchema.parse(
    actions.has('*') || actions.has(parsedAction.data)
      ? { version: 1, allow: true, reasonCode: 'ROLE_ALLOWED' }
      : { version: 1, allow: false, reasonCode: 'ROLE_DENIED' },
  )
}

export function constantTimeEqual(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export type { AuthPrincipal, AuthorizationAction, AuthorizationDecision }
