// WP37 — self-hosted auth kompozisyonu (ADR-0037). Env'den auth servisini
// kurar ve workspace-agent'ın content key lease'i almak için kullandığı,
// YALNIZ iç docker ağında dinleyen (Caddy tarafından yayınlanmayan) içsel
// listener'ı başlatır. İç token dosyadan okunur; env'e/log'a yazılmaz.
import { readFileSync } from 'node:fs'
import Fastify, { type FastifyInstance } from 'fastify'
import type pg from 'pg'
import { ContentKeyLeaseManager } from '@perseverance/workspace-security'
import {
  SelfHostedAuthService,
  constantTimeTokenEquals,
  parseAllowedUsers,
} from './self-hosted-auth'

export interface SelfHostedAuthComposition {
  service: SelfHostedAuthService
  startInternalListener(): Promise<void>
  close(): Promise<void>
}

export function createSelfHostedAuthFromEnv(
  env: NodeJS.ProcessEnv,
  pool: pg.Pool,
  databaseUrl: string,
): SelfHostedAuthComposition | null {
  if (!env.OIDC_SIGNING_KEY_FILE) return null
  const required = (name: string) => {
    const value = env[name]
    if (!value) throw new Error(`Self-hosted auth requires ${name}`)
    return value
  }
  const signingKeyPem = readFileSync(required('OIDC_SIGNING_KEY_FILE'), 'utf8')
  const internalToken = readFileSync(
    required('INTERNAL_RUNTIME_TOKEN_FILE'),
    'utf8',
  ).trim()
  const leases = new ContentKeyLeaseManager({
    ttlMs: Number(env.CONTENT_KEY_LEASE_TTL_SECONDS ?? 12 * 3600) * 1000,
    audit: (event) => {
      // secret.lease_issued/revoked audit'i mevcut tabloya asenkron yazılır;
      // hata lease akışını bloklamaz (audit best-effort, anahtar değeri
      // hiçbir durumda yazılmaz). RLS GUC'ları transaction-yerel olduğundan
      // set_config + INSERT aynı client'ta tek transaction içinde koşar.
      void (async () => {
        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          await client.query(
            `SELECT set_config('app.organization_id',$1,true),
                    set_config('app.workspace_id',$2,true)`,
            [event.scope.organizationId, event.scope.workspaceId],
          )
          await client.query(
            `INSERT INTO persistent_codex.workspace_security_audit(organization_id,workspace_id,action,outcome,reason_code,key_version)
             VALUES ($1,$2,$3,'success','WP37_CONTENT_KEY_LEASE',NULL)`,
            [event.scope.organizationId, event.scope.workspaceId, event.action],
          )
          await client.query('COMMIT')
        } catch {
          await client.query('ROLLBACK').catch(() => undefined)
        } finally {
          client.release()
        }
      })()
    },
  })
  const service = new SelfHostedAuthService({
    pool,
    databaseUrl,
    allowedUsers: parseAllowedUsers(env.SELF_HOSTED_ALLOWED_USERS),
    issuer: required('OIDC_ISSUER'),
    audience: required('OIDC_AUDIENCE'),
    signingKeyPem,
    signingKeyId: env.OIDC_SIGNING_KEY_ID ?? 'self-hosted',
    leases,
    ...(env.ACCESS_TOKEN_TTL_SECONDS
      ? { accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS) }
      : {}),
  })

  let internalApp: FastifyInstance | null = null
  return {
    service,
    async startInternalListener() {
      internalApp = Fastify({ logger: false })
      internalApp.post<{ Body: { workspaceId?: unknown } }>(
        '/internal/v1/content-key-leases',
        async (request, reply) => {
          const header = request.headers.authorization
          const token =
            typeof header === 'string' && header.startsWith('Bearer ')
              ? header.slice(7)
              : ''
          if (
            token.length === 0 ||
            !constantTimeTokenEquals(token, internalToken)
          )
            return reply.code(401).send({ code: 'INTERNAL_TOKEN_INVALID' })
          const workspaceId = String(request.body?.workspaceId ?? '')
          if (workspaceId.length === 0)
            return reply.code(400).send({ code: 'WORKSPACE_ID_REQUIRED' })
          const lease = leases.acquire(workspaceId)
          if (!lease)
            return reply.code(404).send({ code: 'CONTENT_KEY_LOCKED' })
          return reply.code(200).send({
            tenantId: lease.scope.tenantId,
            organizationId: lease.scope.organizationId,
            workspaceId: lease.scope.workspaceId,
            keyVersion: lease.keyVersion,
            contentKey: Buffer.from(lease.contentKey).toString('base64'),
          })
        },
      )
      await internalApp.listen({
        host: '0.0.0.0',
        port: Number(env.CONTENT_KEY_SERVICE_PORT ?? 3304),
      })
    },
    async close() {
      leases.revokeAll()
      if (internalApp) await internalApp.close()
    },
  }
}
