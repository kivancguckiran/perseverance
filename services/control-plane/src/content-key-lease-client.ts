import {
  CONTENT_KEY_BROKER_CONTRACT_VERSION,
  CONTENT_KEY_BROKER_ROUTES,
  contentKeyLeaseAcquireResponseSchema,
  contentKeyLeaseIssueResponseSchema,
  contentKeyLeaseRevokeResponseSchema,
  contentKeyLeaseStatusResponseSchema,
  type ContentKeyLeaseScope,
} from '@perseverance/control-plane-contracts'

type MaybePromise<T> = T | Promise<T>

export interface ContentKeyLeaseRecord {
  leaseId: string
  scope: ContentKeyLeaseScope
  userId: string
  keyVersion: string
  expiresAt: number
}

export interface ContentKeyLeaseMaterial extends ContentKeyLeaseRecord {
  contentKey: Buffer
}

export interface ContentKeyLeaseStore {
  issue(input: {
    scope: ContentKeyLeaseScope
    userId: string
    keyVersion: string
    contentKey: Uint8Array
  }): MaybePromise<ContentKeyLeaseRecord>
  acquire(workspaceId: string): MaybePromise<ContentKeyLeaseMaterial | null>
  hasActiveLease(workspaceId: string): MaybePromise<boolean>
  revoke(workspaceId: string): MaybePromise<boolean>
}

export class ContentKeyLeaseBrokerError extends Error {
  constructor(code: string) {
    super(code)
  }
}

export class HttpContentKeyLeaseStore implements ContentKeyLeaseStore {
  readonly #endpoint: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(endpoint: string, token: string, request: typeof fetch = fetch) {
    this.#endpoint = endpoint.replace(/\/$/, '')
    this.#token = token
    this.#fetch = request
  }

  async #post(path: string, body: unknown): Promise<Response> {
    try {
      return await this.#fetch(`${this.#endpoint}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new ContentKeyLeaseBrokerError('CONTENT_KEY_BROKER_UNAVAILABLE')
    }
  }

  async issue(input: {
    scope: ContentKeyLeaseScope
    userId: string
    keyVersion: string
    contentKey: Uint8Array
  }): Promise<ContentKeyLeaseRecord> {
    if (input.contentKey.byteLength !== 32)
      throw new ContentKeyLeaseBrokerError('INVALID_CONTENT_KEY')
    const response = await this.#post(CONTENT_KEY_BROKER_ROUTES.issue, {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      scope: input.scope,
      userId: input.userId,
      keyVersion: input.keyVersion,
      contentKey: Buffer.from(input.contentKey).toString('base64'),
    })
    if (!response.ok)
      throw new ContentKeyLeaseBrokerError('CONTENT_KEY_BROKER_UNAVAILABLE')
    return contentKeyLeaseIssueResponseSchema.parse(await response.json())
  }

  async acquire(workspaceId: string): Promise<ContentKeyLeaseMaterial | null> {
    const response = await this.#post(CONTENT_KEY_BROKER_ROUTES.acquire, {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      workspaceId,
    })
    if (response.status === 404) return null
    if (!response.ok)
      throw new ContentKeyLeaseBrokerError('CONTENT_KEY_BROKER_UNAVAILABLE')
    const lease = contentKeyLeaseAcquireResponseSchema.parse(
      await response.json(),
    )
    return { ...lease, contentKey: Buffer.from(lease.contentKey, 'base64') }
  }

  async hasActiveLease(workspaceId: string): Promise<boolean> {
    const response = await this.#post(CONTENT_KEY_BROKER_ROUTES.status, {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      workspaceId,
    })
    if (!response.ok)
      throw new ContentKeyLeaseBrokerError('CONTENT_KEY_BROKER_UNAVAILABLE')
    return contentKeyLeaseStatusResponseSchema.parse(await response.json())
      .active
  }

  async revoke(workspaceId: string): Promise<boolean> {
    const response = await this.#post(CONTENT_KEY_BROKER_ROUTES.revoke, {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      workspaceId,
    })
    if (!response.ok)
      throw new ContentKeyLeaseBrokerError('CONTENT_KEY_BROKER_UNAVAILABLE')
    return contentKeyLeaseRevokeResponseSchema.parse(await response.json())
      .revoked
  }
}
