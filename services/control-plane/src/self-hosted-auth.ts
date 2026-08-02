//  self-hosted kullanıcı hesapları ve parola-türevli at-rest mahremiyet
// (ADR-0037). Kayıt yalnız SELF_HOSTED_ALLOWED_USERS allowlist'ine açıktır
// (fail-closed). Parola, recovery key, KEK'ler ve çözülmüş content key diske
// asla yazılmaz; content key login'de çözülür ve bellek-içi lease olarak
// yaşar. Tüm girişimler user_auth_audit'e, anahtar yaşam döngüsü
// workspace_security_audit'e düşer.
import {
  createHash,
  createPrivateKey,
  createSign,
  randomBytes,
  timingSafeEqual,
  type KeyObject,
} from 'node:crypto'
import type pg from 'pg'
import type { SelfHostedSessionTokens as ContractSelfHostedSessionTokens } from '@perseverance/control-plane-contracts'
import {
  ContentKeyLeaseManager,
  RECOVERY_KEK_HKDF_INFO,
  USER_KEK_HKDF_INFO,
  createUserKdfParams,
  deriveUserKek,
  generateContentKey,
  generateRecoveryKey,
  hashUserPassword,
  normalizeRecoveryKey,
  recoveryKeyMatches,
  recoveryKeySha256,
  unwrapContentKey,
  verifyUserPassword,
  wrapContentKey,
  type UserKdfParamsV1,
  type WrappedContentKeyV1,
} from '@perseverance/workspace-security'
import {
  provisionWorkspace,
  snapshotSelfHostedBilling,
} from './self-hosted-provisioning'

export class SelfHostedAuthError extends Error {
  readonly statusCode: number
  constructor(code: string, statusCode: number) {
    super(code)
    this.statusCode = statusCode
  }
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/

export function parseAllowedUsers(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ]
}

// Sabit pencereli, bellek-içi deneme sınırlayıcı: kullanıcı adı başına
// penceredeki başarısız girişimleri sayar; eşik aşımında fail-closed reddeder.
export class AuthAttemptLimiter {
  readonly #attempts = new Map<string, { windowStart: number; count: number }>()
  readonly #limit: number
  readonly #windowMs: number
  readonly #now: () => number

  constructor(options?: {
    limit?: number
    windowMs?: number
    now?: () => number
  }) {
    this.#limit = options?.limit ?? 10
    this.#windowMs = options?.windowMs ?? 15 * 60 * 1000
    this.#now = options?.now ?? Date.now
  }

  allowed(key: string): boolean {
    const now = this.#now()
    const entry = this.#attempts.get(key)
    if (!entry || now - entry.windowStart >= this.#windowMs) return true
    return entry.count < this.#limit
  }

  recordFailure(key: string): void {
    const now = this.#now()
    const entry = this.#attempts.get(key)
    if (!entry || now - entry.windowStart >= this.#windowMs) {
      this.#attempts.set(key, { windowStart: now, count: 1 })
      return
    }
    entry.count += 1
  }

  reset(key: string): void {
    this.#attempts.delete(key)
  }
}

interface StoredUser {
  userId: string
  username: string
  passwordHash: string
  status: 'pending' | 'approved' | 'disabled'
  organizationId: string
  workspaceId: string
  recoveryKeyHash: string
}

interface StoredContentKeyWrap {
  keyVersion: number
  kdfParams: UserKdfParamsV1
  wrappedKey: WrappedContentKeyV1
}

export interface SelfHostedAuthScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export type SelfHostedSessionTokens = ContractSelfHostedSessionTokens

export interface SelfHostedAuthOptions {
  pool: pg.Pool
  databaseUrl: string
  allowedUsers: string[]
  issuer: string
  audience: string
  signingKeyPem: string
  signingKeyId: string
  leases: ContentKeyLeaseManager
  accessTokenTtlSeconds?: number
  limiter?: AuthAttemptLimiter
  now?: () => Date
}

const base64url = (value: Buffer | string): string =>
  Buffer.from(value).toString('base64url')

// identity-service.mjs mint çıktısıyla aynı şekil: RS256, kid'li header,
// amr yalnız ['pwd'] (admin-token'daki 'mfa' iddiası son kullanıcıya taşınmaz).
export function mintRs256AccessToken(input: {
  signingKey: KeyObject
  keyId: string
  issuer: string
  audience: string
  subject: string
  ttlSeconds: number
  now: Date
}): { token: string; expiresAt: Date } {
  const now = Math.floor(input.now.getTime() / 1000)
  const header = base64url(
    JSON.stringify({ alg: 'RS256', kid: input.keyId, typ: 'at+jwt' }),
  )
  const payload = base64url(
    JSON.stringify({
      iss: input.issuer,
      aud: input.audience,
      sub: input.subject,
      token_use: 'access',
      iat: now,
      auth_time: now,
      exp: now + input.ttlSeconds,
      amr: ['pwd'],
    }),
  )
  const unsigned = `${header}.${payload}`
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(input.signingKey)
  return {
    token: `${unsigned}.${base64url(signature)}`,
    expiresAt: new Date((now + input.ttlSeconds) * 1000),
  }
}

export class SelfHostedAuthService {
  readonly #options: SelfHostedAuthOptions
  readonly #signingKey: KeyObject
  readonly #limiter: AuthAttemptLimiter
  readonly #now: () => Date
  readonly #userWorkspaces = new Set<string>()

  constructor(options: SelfHostedAuthOptions) {
    this.#options = options
    this.#signingKey = createPrivateKey(options.signingKeyPem)
    this.#limiter = options.limiter ?? new AuthAttemptLimiter()
    this.#now = options.now ?? (() => new Date())
  }

  get leases(): ContentKeyLeaseManager {
    return this.#options.leases
  }

  subjectFor(username: string): string {
    return `user:${username}`
  }

  // Auth akışı scope öncesi çalıştığından transaction-yerel
  // app.self_hosted_auth_flow GUC'u ile RLS politikasından geçer.
  async #withAuthFlow<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#options.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `SELECT set_config('app.self_hosted_auth_flow','1',true)`,
      )
      const result = await fn(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      client.release()
    }
  }

  async #audit(
    client: pg.PoolClient,
    input: {
      username: string
      action: string
      outcome: 'allow' | 'deny'
      reasonCode: string
      tenantId?: string
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO persistent_codex.user_auth_audit(tenant_id,username,action,outcome,reason_code)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        input.tenantId ?? 'self-hosted-auth',
        input.username,
        input.action,
        input.outcome,
        input.reasonCode,
      ],
    )
  }

  async #securityAudit(
    client: pg.PoolClient,
    scope: SelfHostedAuthScope,
    action: 'key.rotated' | 'workspace.crypto_erased',
    reasonCode: string,
    keyVersion: string | null,
  ): Promise<void> {
    await client.query(
      `SELECT set_config('app.organization_id',$1,true),
              set_config('app.workspace_id',$2,true)`,
      [scope.organizationId, scope.workspaceId],
    )
    await client.query(
      `INSERT INTO persistent_codex.workspace_security_audit(organization_id,workspace_id,action,outcome,reason_code,key_version)
       VALUES ($1,$2,$3,'success',$4,$5)`,
      [scope.organizationId, scope.workspaceId, action, reasonCode, keyVersion],
    )
  }

  async #denied(
    username: string,
    action: string,
    reasonCode: string,
    statusCode: number,
  ): Promise<never> {
    this.#limiter.recordFailure(username)
    await this.#withAuthFlow(async (client) => {
      await this.#audit(client, {
        username,
        action,
        outcome: 'deny',
        reasonCode,
      })
    }).catch(() => undefined)
    throw new SelfHostedAuthError(reasonCode, statusCode)
  }

  async #getUser(
    client: pg.PoolClient,
    username: string,
  ): Promise<StoredUser | null> {
    const result = await client.query(
      `SELECT user_id,username,password_hash,status,organization_id,workspace_id,recovery_key_hash
       FROM persistent_codex.users WHERE username=$1`,
      [username],
    )
    if (result.rowCount === 0) return null
    const row = result.rows[0] as Record<string, string>
    return {
      userId: String(row.user_id),
      username: String(row.username),
      passwordHash: String(row.password_hash),
      status: String(row.status) as StoredUser['status'],
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      recoveryKeyHash: String(row.recovery_key_hash),
    }
  }

  async #getWrap(
    client: pg.PoolClient,
    userId: string,
    wrapType: 'password' | 'recovery',
  ): Promise<StoredContentKeyWrap | null> {
    const result = await client.query(
      `SELECT key_version,kdf_params,wrapped_key
       FROM persistent_codex.user_content_keys WHERE user_id=$1 AND wrap_type=$2`,
      [userId, wrapType],
    )
    if (result.rowCount === 0) return null
    const row = result.rows[0] as {
      key_version: number
      kdf_params: UserKdfParamsV1
      wrapped_key: WrappedContentKeyV1
    }
    return {
      keyVersion: row.key_version,
      kdfParams: row.kdf_params,
      wrappedKey: row.wrapped_key,
    }
  }

  #scopeOf(user: StoredUser): SelfHostedAuthScope {
    return {
      tenantId: user.organizationId,
      organizationId: user.organizationId,
      workspaceId: user.workspaceId,
    }
  }

  #mintAccessToken(subject: string): { token: string; expiresAt: Date } {
    return mintRs256AccessToken({
      signingKey: this.#signingKey,
      keyId: this.#options.signingKeyId,
      issuer: this.#options.issuer,
      audience: this.#options.audience,
      subject,
      ttlSeconds: this.#options.accessTokenTtlSeconds ?? 3600,
      now: this.#now(),
    })
  }

  async #issueSession(
    client: pg.PoolClient,
    user: StoredUser,
  ): Promise<SelfHostedSessionTokens> {
    const access = this.#mintAccessToken(this.subjectFor(user.username))
    const refreshToken = `rt1_${randomBytes(32).toString('base64url')}`
    await client.query(
      `INSERT INTO persistent_codex.user_refresh_tokens(tenant_id,user_id,token_hash,expires_at)
       VALUES ($1,$2,$3,$4)`,
      [
        user.organizationId,
        user.userId,
        createHash('sha256').update(refreshToken).digest('hex'),
        null,
      ],
    )
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: null,
    }
  }

  #issueLease(user: StoredUser, keyVersion: number, contentKey: Buffer): void {
    this.#options.leases.issue({
      scope: this.#scopeOf(user),
      userId: user.userId,
      keyVersion: String(keyVersion),
      contentKey,
    })
  }

  async register(input: { username: string; password: string }): Promise<{
    userId: string
    username: string
    scope: SelfHostedAuthScope
    recoveryKey: string
    session: SelfHostedSessionTokens
  }> {
    const username = input.username.trim().toLowerCase()
    if (!USERNAME_PATTERN.test(username))
      throw new SelfHostedAuthError('INVALID_USERNAME', 400)
    if (typeof input.password !== 'string' || input.password.length < 8)
      throw new SelfHostedAuthError('PASSWORD_TOO_SHORT', 400)
    if (!this.#limiter.allowed(username))
      throw new SelfHostedAuthError('AUTH_RATE_LIMITED', 429)
    if (!this.#options.allowedUsers.includes(username))
      await this.#denied(
        username,
        'user.register_denied',
        'REGISTRATION_NOT_ALLOWED',
        403,
      )

    const passwordHash = await hashUserPassword(input.password)
    const contentKey = generateContentKey()
    const recoveryKey = generateRecoveryKey()
    const userId = `usr_${randomBytes(6).toString('hex')}`
    const organizationId = `org_u_${randomBytes(4).toString('hex')}`
    const workspaceId = `wsp_u_${randomBytes(4).toString('hex')}`
    const passwordKdf = createUserKdfParams(USER_KEK_HKDF_INFO)
    const recoveryKdf = createUserKdfParams(RECOVERY_KEK_HKDF_INFO)
    const passwordKek = await deriveUserKek(input.password, passwordKdf)
    // Recovery-KEK, recovery key'in KENDİSİNDEN türetilir; DB'de doğrulama
    // için duran sha256 hash'i tek yönlüdür ve KDF girdisi DEĞİLDİR (aksi
    // halde operatör hash'ten KEK türetip içeriği açabilirdi).
    const recoveryKek = await deriveUserKek(
      normalizeRecoveryKey(recoveryKey),
      recoveryKdf,
    )
    const baseScope = {
      tenantId: organizationId,
      organizationId,
      workspaceId,
      userId,
    }
    const passwordWrap = wrapContentKey(contentKey, passwordKek, {
      ...baseScope,
      wrapType: 'password',
    })
    const recoveryWrap = wrapContentKey(contentKey, recoveryKek, {
      ...baseScope,
      wrapType: 'recovery',
    })
    passwordKek.fill(0)
    recoveryKek.fill(0)

    const result = await this.#withAuthFlow(async (client) => {
      const existing = await this.#getUser(client, username)
      if (existing) {
        await this.#audit(client, {
          username,
          action: 'user.register_denied',
          outcome: 'deny',
          reasonCode: 'USERNAME_TAKEN',
        })
        throw new SelfHostedAuthError('USERNAME_TAKEN', 409)
      }
      await client.query(
        `INSERT INTO persistent_codex.users
           (tenant_id,user_id,username,password_hash,status,organization_id,workspace_id,recovery_key_hash,approved_at)
         VALUES ($1,$2,$3,$4,'approved',$5,$6,$7,now())`,
        [
          organizationId,
          userId,
          username,
          passwordHash,
          organizationId,
          workspaceId,
          recoveryKeySha256(recoveryKey),
        ],
      )
      for (const [wrapType, kdf, wrap] of [
        ['password', passwordKdf, passwordWrap],
        ['recovery', recoveryKdf, recoveryWrap],
      ] as const) {
        await client.query(
          `INSERT INTO persistent_codex.user_content_keys
             (tenant_id,organization_id,workspace_id,user_id,wrap_type,key_version,kdf_params,wrapped_key)
           VALUES ($1,$2,$3,$4,$5,1,$6,$7)`,
          [
            organizationId,
            organizationId,
            workspaceId,
            userId,
            wrapType,
            JSON.stringify(kdf),
            JSON.stringify(wrap),
          ],
        )
      }
      await provisionWorkspace(client, {
        issuer: this.#options.issuer,
        subject: this.subjectFor(username),
        organizationId,
        organizationName: `Kullanıcı: ${username}`,
        workspaceId,
        workspaceName: `${username} workspace`,
      })
      await this.#audit(client, {
        username,
        action: 'user.registered',
        outcome: 'allow',
        reasonCode: 'ALLOWLISTED',
        tenantId: organizationId,
      })
      const user: StoredUser = {
        userId,
        username,
        passwordHash,
        status: 'approved',
        organizationId,
        workspaceId,
        recoveryKeyHash: recoveryKeySha256(recoveryKey),
      }
      const session = await this.#issueSession(client, user)
      return { user, session }
    })

    await snapshotSelfHostedBilling(this.#options.databaseUrl, {
      tenantId: organizationId,
      organizationId,
      workspaceId,
    })
    this.#userWorkspaces.add(workspaceId)
    this.#issueLease(result.user, 1, contentKey)
    contentKey.fill(0)
    this.#limiter.reset(username)
    return {
      userId,
      username,
      scope: this.#scopeOf(result.user),
      recoveryKey,
      session: result.session,
    }
  }

  async login(input: { username: string; password: string }): Promise<{
    userId: string
    username: string
    scope: SelfHostedAuthScope
    session: SelfHostedSessionTokens
    contentKeyUnlocked: boolean
  }> {
    const username = String(input.username ?? '')
      .trim()
      .toLowerCase()
    if (!this.#limiter.allowed(username))
      throw new SelfHostedAuthError('AUTH_RATE_LIMITED', 429)
    const found = await this.#withAuthFlow(async (client) => {
      const user = await this.#getUser(client, username)
      const wrap = user
        ? await this.#getWrap(client, user.userId, 'password')
        : null
      return { user, wrap }
    })
    const passwordOk = await verifyUserPassword(
      String(input.password ?? ''),
      found.user?.passwordHash ?? null,
    )
    if (!found.user || !passwordOk)
      await this.#denied(
        username,
        'user.login_denied',
        'INVALID_CREDENTIALS',
        401,
      )
    const user = found.user as StoredUser
    if (user.status !== 'approved')
      await this.#denied(username, 'user.login_denied', 'USER_DISABLED', 403)
    if (!found.wrap)
      await this.#denied(
        username,
        'user.login_denied',
        'CONTENT_KEY_MISSING',
        409,
      )
    const wrap = found.wrap as StoredContentKeyWrap
    const kek = await deriveUserKek(String(input.password), wrap.kdfParams)
    let contentKey: Buffer
    try {
      contentKey = unwrapContentKey(wrap.wrappedKey, kek, {
        ...this.#scopeOf(user),
        userId: user.userId,
        wrapType: 'password',
      })
    } catch {
      await this.#denied(
        username,
        'user.login_denied',
        'CONTENT_KEY_UNWRAP_FAILED',
        401,
      )
      throw new Error('unreachable')
    } finally {
      kek.fill(0)
    }
    const session = await this.#withAuthFlow(async (client) => {
      await this.#audit(client, {
        username,
        action: 'user.login',
        outcome: 'allow',
        reasonCode: 'PASSWORD_VERIFIED',
        tenantId: user.organizationId,
      })
      return await this.#issueSession(client, user)
    })
    this.#userWorkspaces.add(user.workspaceId)
    this.#issueLease(user, wrap.keyVersion, contentKey)
    contentKey.fill(0)
    this.#limiter.reset(username)
    return {
      userId: user.userId,
      username: user.username,
      scope: this.#scopeOf(user),
      session,
      contentKeyUnlocked: true,
    }
  }

  async unlock(input: {
    username: string
    password: string
    expectedSubject: string
    expectedScope: SelfHostedAuthScope
  }): Promise<{ contentKeyUnlocked: true }> {
    const username = String(input.username ?? '')
      .trim()
      .toLowerCase()
    if (
      this.subjectFor(username) !== input.expectedSubject ||
      input.expectedScope.tenantId !== input.expectedScope.organizationId
    )
      throw new SelfHostedAuthError('AUTHORIZATION_DENIED', 403)
    if (!this.#limiter.allowed(username))
      throw new SelfHostedAuthError('AUTH_RATE_LIMITED', 429)
    const found = await this.#withAuthFlow(async (client) => {
      const user = await this.#getUser(client, username)
      const wrap = user
        ? await this.#getWrap(client, user.userId, 'password')
        : null
      return { user, wrap }
    })
    const passwordOk = await verifyUserPassword(
      String(input.password ?? ''),
      found.user?.passwordHash ?? null,
    )
    if (!found.user || !passwordOk)
      await this.#denied(
        username,
        'user.unlock_denied',
        'INVALID_CREDENTIALS',
        401,
      )
    const user = found.user as StoredUser
    if (
      user.status !== 'approved' ||
      user.organizationId !== input.expectedScope.organizationId ||
      user.workspaceId !== input.expectedScope.workspaceId
    )
      await this.#denied(
        username,
        'user.unlock_denied',
        'AUTHORIZATION_DENIED',
        403,
      )
    if (!found.wrap)
      await this.#denied(
        username,
        'user.unlock_denied',
        'CONTENT_KEY_MISSING',
        409,
      )
    const wrap = found.wrap as StoredContentKeyWrap
    const kek = await deriveUserKek(String(input.password), wrap.kdfParams)
    let contentKey: Buffer
    try {
      contentKey = unwrapContentKey(wrap.wrappedKey, kek, {
        ...this.#scopeOf(user),
        userId: user.userId,
        wrapType: 'password',
      })
    } catch {
      await this.#denied(
        username,
        'user.unlock_denied',
        'CONTENT_KEY_UNWRAP_FAILED',
        401,
      )
      throw new Error('unreachable')
    } finally {
      kek.fill(0)
    }
    await this.#withAuthFlow(async (client) => {
      await this.#audit(client, {
        username,
        action: 'user.content_key_unlocked',
        outcome: 'allow',
        reasonCode: 'PASSWORD_VERIFIED',
        tenantId: user.organizationId,
      })
    })
    this.#userWorkspaces.add(user.workspaceId)
    this.#issueLease(user, wrap.keyVersion, contentKey)
    contentKey.fill(0)
    this.#limiter.reset(username)
    return { contentKeyUnlocked: true }
  }

  async refresh(input: { refreshToken: string }): Promise<{
    username: string
    scope: SelfHostedAuthScope
    session: SelfHostedSessionTokens
    contentKeyUnlocked: boolean
  }> {
    const tokenHash = createHash('sha256')
      .update(String(input.refreshToken ?? ''))
      .digest('hex')
    const result = await this.#withAuthFlow(async (client) => {
      const stored = await client.query(
        `SELECT t.user_id,t.revoked_at,u.username,u.status,u.organization_id,u.workspace_id,u.password_hash,u.recovery_key_hash
         FROM persistent_codex.user_refresh_tokens t
         JOIN persistent_codex.users u ON u.user_id=t.user_id
         WHERE t.token_hash=$1`,
        [tokenHash],
      )
      if (stored.rowCount === 0)
        throw new SelfHostedAuthError('REFRESH_TOKEN_INVALID', 401)
      const row = stored.rows[0] as Record<string, string | null>
      if (row.revoked_at)
        throw new SelfHostedAuthError('REFRESH_TOKEN_REVOKED', 401)
      if (row.status !== 'approved')
        throw new SelfHostedAuthError('USER_DISABLED', 403)
      await client.query(
        `UPDATE persistent_codex.user_refresh_tokens SET revoked_at=now() WHERE token_hash=$1`,
        [tokenHash],
      )
      const user: StoredUser = {
        userId: String(row.user_id),
        username: String(row.username),
        passwordHash: String(row.password_hash),
        status: 'approved',
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        recoveryKeyHash: String(row.recovery_key_hash),
      }
      const session = await this.#issueSession(client, user)
      return { user, session }
    })
    this.#userWorkspaces.add(result.user.workspaceId)
    return {
      username: result.user.username,
      scope: this.#scopeOf(result.user),
      session: result.session,
      contentKeyUnlocked: this.#options.leases.hasActiveLease(
        result.user.workspaceId,
      ),
    }
  }

  async recover(input: {
    username: string
    recoveryKey: string
    newPassword: string
  }): Promise<{
    username: string
    scope: SelfHostedAuthScope
    recoveryKey: string
    session: SelfHostedSessionTokens
  }> {
    const username = String(input.username ?? '')
      .trim()
      .toLowerCase()
    if (typeof input.newPassword !== 'string' || input.newPassword.length < 8)
      throw new SelfHostedAuthError('PASSWORD_TOO_SHORT', 400)
    if (!this.#limiter.allowed(username))
      throw new SelfHostedAuthError('AUTH_RATE_LIMITED', 429)
    const found = await this.#withAuthFlow(async (client) => {
      const user = await this.#getUser(client, username)
      const wrap = user
        ? await this.#getWrap(client, user.userId, 'recovery')
        : null
      return { user, wrap }
    })
    if (
      !found.user ||
      !found.wrap ||
      !recoveryKeyMatches(
        String(input.recoveryKey ?? ''),
        found.user.recoveryKeyHash,
      )
    )
      await this.#denied(
        username,
        'user.recover_denied',
        'INVALID_RECOVERY_KEY',
        401,
      )
    const user = found.user as StoredUser
    if (user.status !== 'approved')
      await this.#denied(username, 'user.recover_denied', 'USER_DISABLED', 403)
    const recoveryWrapStored = found.wrap as StoredContentKeyWrap
    const oldRecoveryKek = await deriveUserKek(
      normalizeRecoveryKey(String(input.recoveryKey)),
      recoveryWrapStored.kdfParams,
    )
    let contentKey: Buffer
    try {
      contentKey = unwrapContentKey(
        recoveryWrapStored.wrappedKey,
        oldRecoveryKek,
        {
          ...this.#scopeOf(user),
          userId: user.userId,
          wrapType: 'recovery',
        },
      )
    } catch {
      await this.#denied(
        username,
        'user.recover_denied',
        'CONTENT_KEY_UNWRAP_FAILED',
        401,
      )
      throw new Error('unreachable')
    } finally {
      oldRecoveryKek.fill(0)
    }

    const nextKeyVersion = recoveryWrapStored.keyVersion + 1
    const newPasswordHash = await hashUserPassword(input.newPassword)
    const newRecoveryKey = generateRecoveryKey()
    const passwordKdf = createUserKdfParams(USER_KEK_HKDF_INFO)
    const recoveryKdf = createUserKdfParams(RECOVERY_KEK_HKDF_INFO)
    const passwordKek = await deriveUserKek(input.newPassword, passwordKdf)
    const recoveryKek = await deriveUserKek(
      normalizeRecoveryKey(newRecoveryKey),
      recoveryKdf,
    )
    const baseScope = {
      ...this.#scopeOf(user),
      userId: user.userId,
    }
    const passwordWrap = wrapContentKey(contentKey, passwordKek, {
      ...baseScope,
      wrapType: 'password',
    })
    const recoveryWrap = wrapContentKey(contentKey, recoveryKek, {
      ...baseScope,
      wrapType: 'recovery',
    })
    passwordKek.fill(0)
    recoveryKek.fill(0)

    const session = await this.#withAuthFlow(async (client) => {
      await client.query(
        `UPDATE persistent_codex.users SET password_hash=$1,recovery_key_hash=$2 WHERE user_id=$3`,
        [newPasswordHash, recoveryKeySha256(newRecoveryKey), user.userId],
      )
      for (const [wrapType, kdf, wrap] of [
        ['password', passwordKdf, passwordWrap],
        ['recovery', recoveryKdf, recoveryWrap],
      ] as const) {
        await client.query(
          `UPDATE persistent_codex.user_content_keys
           SET key_version=$1,kdf_params=$2,wrapped_key=$3,rotated_at=now()
           WHERE user_id=$4 AND wrap_type=$5`,
          [
            nextKeyVersion,
            JSON.stringify(kdf),
            JSON.stringify(wrap),
            user.userId,
            wrapType,
          ],
        )
      }
      await client.query(
        `UPDATE persistent_codex.user_refresh_tokens SET revoked_at=now()
         WHERE user_id=$1 AND revoked_at IS NULL`,
        [user.userId],
      )
      await this.#audit(client, {
        username,
        action: 'user.recovered',
        outcome: 'allow',
        reasonCode: 'RECOVERY_KEY_VERIFIED',
        tenantId: user.organizationId,
      })
      await this.#securityAudit(
        client,
        this.#scopeOf(user),
        'key.rotated',
        'SELF_HOSTED_RECOVERY_REWRAP',
        String(nextKeyVersion),
      )
      return await this.#issueSession(client, user)
    })
    this.#userWorkspaces.add(user.workspaceId)
    this.#issueLease(user, nextKeyVersion, contentKey)
    contentKey.fill(0)
    this.#limiter.reset(username)
    return {
      username: user.username,
      scope: this.#scopeOf(user),
      recoveryKey: newRecoveryKey,
      session,
    }
  }

  async logout(input: { refreshToken?: string }): Promise<void> {
    const refreshToken = String(input.refreshToken ?? '')
    if (refreshToken.length === 0) return
    const tokenHash = createHash('sha256').update(refreshToken).digest('hex')
    await this.#withAuthFlow(async (client) => {
      const stored = await client.query(
        `UPDATE persistent_codex.user_refresh_tokens SET revoked_at=now()
         WHERE token_hash=$1 AND revoked_at IS NULL
         RETURNING user_id`,
        [tokenHash],
      )
      if (stored.rowCount === 0) return
      const userId = String((stored.rows[0] as { user_id: string }).user_id)
      const user = await client.query(
        `SELECT username,organization_id,workspace_id FROM persistent_codex.users WHERE user_id=$1`,
        [userId],
      )
      if (user.rowCount === 0) return
      const row = user.rows[0] as Record<string, string>
      this.#options.leases.revoke(String(row.workspace_id))
      await this.#audit(client, {
        username: String(row.username),
        action: 'user.logout',
        outcome: 'allow',
        reasonCode: 'REFRESH_TOKEN_REVOKED',
        tenantId: String(row.organization_id),
      })
    })
  }

  // İçerik şifreleme kapsamındaki (kayıtlı kullanıcıya ait) workspace mi?
  // Kayıt/giriş görmüş workspace'ler süreç içinde cache'lenir; cache
  // kaçırmalarında DB'ye düşülür (fail-closed: hata → true varsayılmaz,
  // sorgu sonucu ne derse o).
  async isUserWorkspace(workspaceId: string): Promise<boolean> {
    if (this.#userWorkspaces.has(workspaceId)) return true
    const result = await this.#withAuthFlow(async (client) =>
      client.query(
        `SELECT 1 FROM persistent_codex.users WHERE workspace_id=$1 LIMIT 1`,
        [workspaceId],
      ),
    )
    if ((result.rowCount ?? 0) > 0) {
      this.#userWorkspaces.add(workspaceId)
      return true
    }
    return false
  }
}

export function constantTimeTokenEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a).digest()
  const right = createHash('sha256').update(b).digest()
  return timingSafeEqual(left, right)
}
