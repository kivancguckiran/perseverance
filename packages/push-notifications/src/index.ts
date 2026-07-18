import { createHash, randomUUID } from 'node:crypto'
import type {
  PushDeliveryReceipt,
  PushNotificationPayload,
  PushOutboxRecord,
  PushSubscription,
  PushSubscriptionRequest,
  PushNotificationResolution,
} from '@persistent-codex/control-plane-contracts'
import {
  EnvelopeEncryption,
  type EnvelopeV1,
} from '@persistent-codex/workspace-security'
import { Pool, type PoolClient } from 'pg'

export const PUSH_REPOSITORY_VERSION = 1 as const

export interface PushScope {
  tenantId: string
  organizationId: string
  workspaceId: string
  principalId: string
}

export interface PushProviderDelivery {
  endpoint: string
  keys: { p256dh: string; auth: string }
  payload: PushNotificationPayload
}

export interface PushProvider {
  readonly kind: 'emulator' | 'web-push'
  deliver(input: PushProviderDelivery): Promise<{
    outcome: 'delivered' | 'retry' | 'invalid_endpoint'
    providerMessageId: string | null
  }>
}

interface SecretMaterial {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

interface StoredSubscription extends Omit<PushSubscription, 'revision'> {
  rowVersion: number
  secret: EnvelopeV1
}

export interface PushRepository {
  readonly adapter: 'memory' | 'postgresql'
  upsert(
    scope: PushScope,
    request: PushSubscriptionRequest,
  ): Promise<PushSubscription>
  list(scope: PushScope): Promise<PushSubscription[]>
  revoke(
    scope: PushScope,
    subscriptionId: string,
    expectedVersion: number,
  ): Promise<PushSubscription>
  revokeDevice(scope: PushScope, deviceId: string): Promise<number>
  expire(now: Date): Promise<number>
  resolveNotification(
    principalId: string,
    notificationId: string,
    now: Date,
  ): Promise<PushNotificationResolution | undefined>
  enqueue(
    scope: Omit<PushScope, 'principalId'>,
    input: {
      notificationId: string
      sessionId: string
      approvalId: string | null
      status: PushNotificationPayload['status']
    },
  ): Promise<number>
  drain(
    provider: PushProvider,
    now: Date,
    limit?: number,
  ): Promise<PushDeliveryReceipt[]>
  close(): Promise<void>
}

export class PushRepositoryError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.code = code
    this.name = 'PushRepositoryError'
  }
}

function fingerprint(endpoint: string) {
  return `sha256:${createHash('sha256').update(endpoint).digest('hex')}`
}

function encryptionContext(scope: PushScope, subscriptionId: string) {
  return {
    tenantId: scope.tenantId,
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    recordType: 'push_subscription' as const,
    recordId: subscriptionId,
    additionalAuthenticatedData: { principalId: scope.principalId },
  }
}

function publicSubscription(row: StoredSubscription): PushSubscription {
  const { rowVersion: _rowVersion, secret: _secret, ...value } = row
  return { ...value, revision: row.rowVersion }
}

export class InMemoryPushRepository implements PushRepository {
  readonly adapter: PushRepository['adapter'] = 'memory'
  readonly rows = new Map<string, StoredSubscription>()
  readonly outbox = new Map<string, PushOutboxRecord>()
  readonly receipts = new Map<string, PushDeliveryReceipt>()
  readonly encryption: EnvelopeEncryption
  constructor(encryption: EnvelopeEncryption) {
    this.encryption = encryption
  }

  async upsert(scope: PushScope, request: PushSubscriptionRequest) {
    const existing = [...this.rows.values()].find(
      (row) =>
        row.tenantId === scope.tenantId &&
        row.organizationId === scope.organizationId &&
        row.workspaceId === scope.workspaceId &&
        row.principalId === scope.principalId &&
        row.deviceId === request.deviceId,
    )
    const subscriptionId = existing?.subscriptionId ?? randomUUID()
    const now = new Date().toISOString()
    const secret = await this.encryption.encrypt(
      encryptionContext(scope, subscriptionId),
      Buffer.from(
        JSON.stringify({ endpoint: request.endpoint, keys: request.keys }),
      ),
    )
    const row: StoredSubscription = {
      version: 1,
      subscriptionId,
      deviceId: request.deviceId,
      ...scope,
      status: 'active',
      endpointFingerprint: fingerprint(request.endpoint),
      expiresAt: request.expiresAt,
      createdAt: existing?.createdAt ?? now,
      rotatedAt: now,
      revokedAt: null,
      rowVersion: (existing?.rowVersion ?? 0) + 1,
      secret,
    }
    this.rows.set(subscriptionId, row)
    return publicSubscription(row)
  }

  async list(scope: PushScope) {
    return [...this.rows.values()]
      .filter((row) =>
        Object.entries(scope).every(
          ([key, value]) => row[key as keyof StoredSubscription] === value,
        ),
      )
      .map(publicSubscription)
  }

  async revoke(
    scope: PushScope,
    subscriptionId: string,
    expectedVersion: number,
  ) {
    const row = this.rows.get(subscriptionId)
    if (
      !row ||
      !Object.entries(scope).every(
        ([key, value]) => row[key as keyof StoredSubscription] === value,
      )
    )
      throw new PushRepositoryError('PUSH_SUBSCRIPTION_NOT_FOUND')
    if (row.rowVersion !== expectedVersion)
      throw new PushRepositoryError('PUSH_SUBSCRIPTION_VERSION_CONFLICT')
    row.status = 'revoked'
    row.revokedAt = new Date().toISOString()
    row.rowVersion++
    return publicSubscription(row)
  }

  async revokeDevice(scope: PushScope, deviceId: string) {
    let count = 0
    for (const row of this.rows.values()) {
      if (row.deviceId !== deviceId || row.status !== 'active') continue
      if (
        !Object.entries(scope).every(
          ([key, value]) => row[key as keyof StoredSubscription] === value,
        )
      )
        continue
      row.status = 'revoked'
      row.revokedAt = new Date().toISOString()
      row.rowVersion++
      count++
    }
    return count
  }

  async expire(now: Date) {
    let count = 0
    for (const row of this.rows.values()) {
      if (
        row.status === 'active' &&
        row.expiresAt &&
        Date.parse(row.expiresAt) <= now.getTime()
      ) {
        row.status = 'expired'
        row.rowVersion++
        count++
      }
    }
    return count
  }

  async resolveNotification(
    principalId: string,
    notificationId: string,
    now: Date,
  ) {
    const outbox = [...this.outbox.values()].find(
      (row) =>
        row.notificationId === notificationId &&
        row.principalId === principalId,
    )
    if (!outbox) return undefined
    const subscription = this.rows.get(outbox.subscriptionId)
    if (
      !subscription ||
      subscription.status !== 'active' ||
      (subscription.expiresAt &&
        Date.parse(subscription.expiresAt) <= now.getTime())
    )
      return undefined
    return {
      version: 1 as const,
      notificationId,
      tenantId: outbox.tenantId,
      organizationId: outbox.organizationId,
      workspaceId: outbox.workspaceId,
      sessionId: outbox.payload.sessionId,
      approvalId: outbox.payload.approvalId,
      status: outbox.payload.status,
    }
  }

  async enqueue(
    scope: Omit<PushScope, 'principalId'>,
    input: {
      notificationId: string
      sessionId: string
      approvalId: string | null
      status: PushNotificationPayload['status']
    },
  ) {
    let count = 0
    for (const row of this.rows.values()) {
      if (
        row.status !== 'active' ||
        !Object.entries(scope).every(
          ([key, value]) => row[key as keyof StoredSubscription] === value,
        )
      )
        continue
      const outboxId = createHash('sha256')
        .update(JSON.stringify([input.notificationId, row.subscriptionId]))
        .digest('hex')
      if (this.outbox.has(outboxId)) continue
      const createdAt = new Date().toISOString()
      this.outbox.set(outboxId, {
        version: 1,
        outboxId,
        notificationId: input.notificationId,
        ...scope,
        principalId: row.principalId,
        deviceId: row.deviceId,
        subscriptionId: row.subscriptionId,
        payload: { version: 1, ...input },
        status: 'pending',
        attempt: 0,
        availableAt: createdAt,
        deliveredAt: null,
        createdAt,
      })
      count++
    }
    return count
  }

  async drain(provider: PushProvider, now: Date, limit = 100) {
    const receipts: PushDeliveryReceipt[] = []
    const candidates = [...this.outbox.values()]
      .filter(
        (row) =>
          ['pending', 'retry'].includes(row.status) &&
          Date.parse(row.availableAt) <= now.getTime(),
      )
      .slice(0, limit)
    for (const outbox of candidates) {
      const subscription = this.rows.get(outbox.subscriptionId)
      if (!subscription || subscription.status !== 'active') {
        outbox.status = 'discarded'
        continue
      }
      outbox.status = 'delivering'
      outbox.attempt++
      const plaintext = await this.encryption.decrypt(
        encryptionContext(subscription, subscription.subscriptionId),
        subscription.secret,
      )
      let material: SecretMaterial
      try {
        material = JSON.parse(
          Buffer.from(plaintext).toString('utf8'),
        ) as SecretMaterial
      } finally {
        plaintext.fill(0)
      }
      const result = await provider.deliver({
        ...material,
        payload: outbox.payload,
      })
      const receipt: PushDeliveryReceipt = {
        version: 1,
        deliveryId: createHash('sha256')
          .update(`${outbox.outboxId}:${outbox.attempt}`)
          .digest('hex'),
        outboxId: outbox.outboxId,
        providerMessageId: result.providerMessageId,
        outcome: result.outcome,
        attempt: outbox.attempt,
        occurredAt: now.toISOString(),
      }
      if (!this.receipts.has(receipt.deliveryId))
        this.receipts.set(receipt.deliveryId, receipt)
      receipts.push(receipt)
      if (result.outcome === 'delivered') {
        outbox.status = 'delivered'
        outbox.deliveredAt = now.toISOString()
      } else if (result.outcome === 'invalid_endpoint') {
        outbox.status = 'discarded'
        subscription.status = 'invalid'
        subscription.rowVersion++
      } else {
        outbox.status = 'retry'
        outbox.availableAt = new Date(
          now.getTime() + Math.min(300_000, 1_000 * 2 ** outbox.attempt),
        ).toISOString()
      }
    }
    return receipts
  }
  async close() {}
}

export class PostgresPushRepository extends InMemoryPushRepository {
  override readonly adapter: PushRepository['adapter'] = 'postgresql'
  readonly pool: Pool
  constructor(pool: Pool, encryption: EnvelopeEncryption) {
    super(encryption)
    this.pool = pool
  }

  private async transaction<T>(
    scope: PushScope,
    action: (client: PoolClient) => Promise<T>,
  ) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        "SELECT set_config('app.organization_id',$1,true), set_config('app.workspace_id',$2,true), set_config('app.principal_id',$3,true)",
        [scope.organizationId, scope.workspaceId, scope.principalId],
      )
      const result = await action(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  override async upsert(scope: PushScope, request: PushSubscriptionRequest) {
    return this.transaction(scope, async (client) => {
      await client.query(
        `INSERT INTO persistent_codex.push_devices (tenant_id,organization_id,workspace_id,principal_id,device_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,organization_id,workspace_id,principal_id,device_id) DO UPDATE SET status='active',last_seen_at=now()`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          scope.principalId,
          request.deviceId,
        ],
      )
      const current = await client.query(
        'SELECT subscription_id FROM persistent_codex.push_subscriptions WHERE principal_id=$1 AND device_id=$2',
        [scope.principalId, request.deviceId],
      )
      const subscriptionId = current.rows[0]?.subscription_id
        ? String(current.rows[0].subscription_id)
        : randomUUID()
      const secret = await this.encryption.encrypt(
        encryptionContext(scope, subscriptionId),
        Buffer.from(
          JSON.stringify({ endpoint: request.endpoint, keys: request.keys }),
        ),
      )
      const result = await client.query(
        `INSERT INTO persistent_codex.push_subscriptions (tenant_id,organization_id,workspace_id,principal_id,subscription_id,device_id,endpoint_fingerprint,secret_envelope,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (tenant_id,organization_id,workspace_id,principal_id,device_id) DO UPDATE SET endpoint_fingerprint=excluded.endpoint_fingerprint,secret_envelope=excluded.secret_envelope,expires_at=excluded.expires_at,status='active',rotated_at=now(),revoked_at=NULL,row_version=persistent_codex.push_subscriptions.row_version+1 RETURNING *`,
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          scope.principalId,
          subscriptionId,
          request.deviceId,
          fingerprint(request.endpoint),
          JSON.stringify(secret),
          request.expiresAt,
        ],
      )
      return mapSubscription(result.rows[0])
    })
  }
  override async list(scope: PushScope) {
    return this.transaction(scope, async (client) =>
      (
        await client.query(
          'SELECT * FROM persistent_codex.push_subscriptions ORDER BY created_at',
        )
      ).rows.map(mapSubscription),
    )
  }
  override async revoke(scope: PushScope, id: string, version: number) {
    return this.transaction(scope, async (client) => {
      const result = await client.query(
        "UPDATE persistent_codex.push_subscriptions SET status='revoked',revoked_at=now(),row_version=row_version+1 WHERE subscription_id=$1 AND row_version=$2 AND status='active' RETURNING *",
        [id, version],
      )
      if (!result.rowCount)
        throw new PushRepositoryError('PUSH_SUBSCRIPTION_VERSION_CONFLICT')
      return mapSubscription(result.rows[0])
    })
  }
  override async revokeDevice(scope: PushScope, deviceId: string) {
    return this.transaction(
      scope,
      async (client) =>
        (
          await client.query(
            "UPDATE persistent_codex.push_subscriptions SET status='revoked',revoked_at=now(),row_version=row_version+1 WHERE device_id=$1 AND status='active'",
            [deviceId],
          )
        ).rowCount ?? 0,
    )
  }
  override async expire(now: Date) {
    const result = await this.pool.query(
      'SELECT persistent_codex.push_expire_subscriptions($1) AS count',
      [now],
    )
    return Number(result.rows[0]?.count ?? 0)
  }
  override async resolveNotification(
    principalId: string,
    notificationId: string,
    now: Date,
  ) {
    const result = await this.pool.query(
      'SELECT * FROM persistent_codex.push_resolve_notification($1,$2,$3)',
      [principalId, notificationId, now],
    )
    const row = result.rows[0]
    if (!row) return undefined
    const payload = row.payload as PushNotificationPayload
    return {
      version: 1 as const,
      notificationId,
      tenantId: String(row.tenant_id),
      organizationId: String(row.organization_id),
      workspaceId: String(row.workspace_id),
      sessionId: payload.sessionId,
      approvalId: payload.approvalId,
      status: payload.status,
    }
  }
  override async enqueue(
    scope: Omit<PushScope, 'principalId'>,
    input: {
      notificationId: string
      sessionId: string
      approvalId: string | null
      status: PushNotificationPayload['status']
    },
  ) {
    const result = await this.pool.query(
      'SELECT persistent_codex.push_enqueue_notification($1,$2,$3,$4,$5::jsonb) AS count',
      [
        scope.tenantId,
        scope.organizationId,
        scope.workspaceId,
        input.notificationId,
        JSON.stringify({ version: 1, ...input }),
      ],
    )
    return Number(result.rows[0]?.count ?? 0)
  }
  override async drain(provider: PushProvider, now: Date, limit = 100) {
    const claimed = await this.pool.query(
      'SELECT * FROM persistent_codex.push_claim_deliveries($1,$2)',
      [now, limit],
    )
    const receipts: PushDeliveryReceipt[] = []
    for (const row of claimed.rows) {
      const scope: PushScope = {
        tenantId: String(row.tenant_id),
        organizationId: String(row.organization_id),
        workspaceId: String(row.workspace_id),
        principalId: String(row.principal_id),
      }
      const plaintext = await this.encryption.decrypt(
        encryptionContext(scope, String(row.subscription_id)),
        row.secret_envelope as EnvelopeV1,
      )
      let material: SecretMaterial
      try {
        material = JSON.parse(
          Buffer.from(plaintext).toString('utf8'),
        ) as SecretMaterial
      } finally {
        plaintext.fill(0)
      }
      const result = await provider.deliver({
        ...material,
        payload: row.payload as PushNotificationPayload,
      })
      await this.pool.query(
        'SELECT persistent_codex.push_complete_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          scope.tenantId,
          scope.organizationId,
          scope.workspaceId,
          scope.principalId,
          row.outbox_id,
          row.subscription_id,
          row.attempt,
          result.outcome,
          result.providerMessageId,
          now,
        ],
      )
      receipts.push({
        version: 1,
        deliveryId: createHash('sha256')
          .update(`${row.outbox_id}:${row.attempt}`)
          .digest('hex'),
        outboxId: String(row.outbox_id),
        providerMessageId: result.providerMessageId,
        outcome: result.outcome,
        attempt: Number(row.attempt),
        occurredAt: now.toISOString(),
      })
    }
    return receipts
  }
  override async close() {
    await this.pool.end()
  }
}

function mapSubscription(row: Record<string, unknown>): PushSubscription {
  return {
    version: 1,
    subscriptionId: String(row.subscription_id),
    deviceId: String(row.device_id),
    tenantId: String(row.tenant_id),
    organizationId: String(row.organization_id),
    workspaceId: String(row.workspace_id),
    principalId: String(row.principal_id),
    status: row.status as PushSubscription['status'],
    revision: Number(row.row_version),
    endpointFingerprint: String(row.endpoint_fingerprint),
    expiresAt: row.expires_at
      ? new Date(row.expires_at as string).toISOString()
      : null,
    createdAt: new Date(row.created_at as string).toISOString(),
    rotatedAt: new Date(row.rotated_at as string).toISOString(),
    revokedAt: row.revoked_at
      ? new Date(row.revoked_at as string).toISOString()
      : null,
  }
}

export function createPostgresPushRepository(input: {
  connectionString: string
  encryption: EnvelopeEncryption
}) {
  return new PostgresPushRepository(
    new Pool({ connectionString: input.connectionString, max: 4 }),
    input.encryption,
  )
}

export class PushProviderEmulator implements PushProvider {
  readonly kind = 'emulator' as const
  readonly deliveries: Array<{
    endpointFingerprint: string
    payload: PushNotificationPayload
  }> = []
  async deliver(input: PushProviderDelivery) {
    if (input.endpoint.includes('/invalid'))
      return { outcome: 'invalid_endpoint' as const, providerMessageId: null }
    if (input.endpoint.includes('/retry'))
      return { outcome: 'retry' as const, providerMessageId: null }
    this.deliveries.push({
      endpointFingerprint: fingerprint(input.endpoint),
      payload: input.payload,
    })
    return { outcome: 'delivered' as const, providerMessageId: randomUUID() }
  }
}
