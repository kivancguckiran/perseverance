import { timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'
import {
  CONTENT_KEY_BROKER_CONTRACT_VERSION,
  CONTENT_KEY_BROKER_ROUTES,
  contentKeyLeaseAuditEventSchema,
  contentKeyLeaseIssueRequestSchema,
  contentKeyLeaseLookupRequestSchema,
  type ContentKeyLeaseAuditEvent,
} from '@perseverance/control-plane-contracts'
import {
  ContentKeyLeaseManager,
  type ContentKeyLeaseAudit,
} from '@perseverance/workspace-security'

const tokenEquals = (left: string, right: string): boolean => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

class LeaseAuditQueue {
  readonly #events: ContentKeyLeaseAuditEvent[] = []
  readonly #endpoint: string | null
  readonly #token: string
  readonly #request: typeof fetch
  readonly #retryMs: number
  #flushing = false
  #timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: {
    endpoint?: string
    token: string
    request?: typeof fetch
    retryMs?: number
  }) {
    this.#endpoint = options.endpoint?.replace(/\/$/, '') ?? null
    this.#token = options.token
    this.#request = options.request ?? fetch
    this.#retryMs = options.retryMs ?? 2_000
  }

  get size(): number {
    return this.#events.length
  }

  push(event: ContentKeyLeaseAudit): void {
    const parsed = contentKeyLeaseAuditEventSchema.parse({
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      ...event,
    })
    // The former in-process audit path was best-effort. Keep the broker
    // bounded without ever logging key material or blocking key revocation.
    if (this.#events.length >= 10_000) this.#events.shift()
    this.#events.push(parsed)
    void this.flush()
  }

  async flush(): Promise<void> {
    if (this.#flushing || !this.#endpoint || this.#events.length === 0) return
    this.#flushing = true
    let retry = false
    try {
      while (this.#events.length > 0) {
        const event = this.#events[0]
        let response: Response
        try {
          response = await this.#request(
            `${this.#endpoint}${CONTENT_KEY_BROKER_ROUTES.audit}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${this.#token}`,
              },
              body: JSON.stringify(event),
            },
          )
        } catch {
          retry = true
          break
        }
        if (!response.ok) {
          retry = true
          break
        }
        this.#events.shift()
      }
    } finally {
      this.#flushing = false
      if (retry && !this.#timer) {
        this.#timer = setTimeout(() => {
          this.#timer = null
          void this.flush()
        }, this.#retryMs)
        this.#timer.unref()
      }
    }
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }
}

export interface ContentKeyBrokerOptions {
  internalToken: string
  ttlMs: number
  auditEndpoint?: string
  request?: typeof fetch
  auditRetryMs?: number
}

export async function buildContentKeyBroker(
  options: ContentKeyBrokerOptions,
): Promise<FastifyInstance> {
  if (!options.internalToken) throw new Error('INTERNAL_TOKEN_REQUIRED')
  const audits = new LeaseAuditQueue({
    token: options.internalToken,
    ...(options.auditEndpoint ? { endpoint: options.auditEndpoint } : {}),
    ...(options.request ? { request: options.request } : {}),
    ...(options.auditRetryMs ? { retryMs: options.auditRetryMs } : {}),
  })
  const leases = new ContentKeyLeaseManager({
    ttlMs: options.ttlMs,
    audit: (event) => audits.push(event),
  })
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === CONTENT_KEY_BROKER_ROUTES.readiness) return
    const header = request.headers.authorization
    const token =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice(7)
        : ''
    if (!token || !tokenEquals(token, options.internalToken))
      return reply.code(401).send({ code: 'INTERNAL_TOKEN_INVALID' })
  })
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({ code: 'INVALID_REQUEST' })
    throw error
  })

  app.get(CONTENT_KEY_BROKER_ROUTES.readiness, async () => ({
    ready: true,
    auditQueueDepth: audits.size,
  }))
  app.post(CONTENT_KEY_BROKER_ROUTES.issue, async (request, reply) => {
    const body = contentKeyLeaseIssueRequestSchema.parse(request.body)
    const contentKey = Buffer.from(body.contentKey, 'base64')
    try {
      const lease = leases.issue({
        scope: body.scope,
        userId: body.userId,
        keyVersion: body.keyVersion,
        contentKey,
      })
      return reply.code(201).send({
        schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
        ...lease,
      })
    } finally {
      contentKey.fill(0)
    }
  })
  app.post(CONTENT_KEY_BROKER_ROUTES.acquire, async (request, reply) => {
    const body = contentKeyLeaseLookupRequestSchema.parse(request.body)
    const lease = leases.acquire(body.workspaceId)
    if (!lease) return reply.code(404).send({ code: 'CONTENT_KEY_LOCKED' })
    return reply.code(200).send({
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      leaseId: lease.leaseId,
      scope: lease.scope,
      userId: lease.userId,
      keyVersion: lease.keyVersion,
      expiresAt: lease.expiresAt,
      contentKey: Buffer.from(lease.contentKey).toString('base64'),
    })
  })
  app.post(CONTENT_KEY_BROKER_ROUTES.status, async (request) => {
    const body = contentKeyLeaseLookupRequestSchema.parse(request.body)
    return {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      active: leases.hasActiveLease(body.workspaceId),
    }
  })
  app.post(CONTENT_KEY_BROKER_ROUTES.revoke, async (request) => {
    const body = contentKeyLeaseLookupRequestSchema.parse(request.body)
    return {
      schemaVersion: CONTENT_KEY_BROKER_CONTRACT_VERSION,
      revoked: leases.revoke(body.workspaceId),
    }
  })
  app.addHook('onClose', async () => {
    leases.revokeAll()
    await audits.flush()
    audits.close()
  })
  return app
}
