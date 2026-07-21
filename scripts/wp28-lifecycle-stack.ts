import { randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { S3CompatibleObjectStore } from '../packages/production-topology/src/durable-dependencies'
import type { LifecycleAdapters } from '../packages/enterprise-lifecycle/src/durable'
import { Wp28PostgresStack } from './wp28-postgres-stack'

export class Wp28LifecycleStack extends Wp28PostgresStack {
  readonly minio = `persistent-wp28-minio-${randomUUID()}`
  readonly redis = `persistent-wp28-redis-${randomUUID()}`
  readonly vault = `persistent-wp28-vault-${randomUUID()}`
  object!: S3CompatibleObjectStore
  vaultBase = ''
  keyVersions = new Map<string, number>()
  async startLifecycle() {
    await this.start()
    this.docker([
      'run',
      '-d',
      '--name',
      this.minio,
      '--label',
      'persistent.wp28=true',
      '--tmpfs',
      '/data:size=256m',
      '-e',
      'MINIO_ROOT_USER=wp28access',
      '-e',
      'MINIO_ROOT_PASSWORD=wp28-secret-marker',
      '-p',
      '127.0.0.1::9000',
      'minio/minio:latest',
      'server',
      '/data',
    ])
    this.docker([
      'run',
      '-d',
      '--name',
      this.redis,
      '--label',
      'persistent.wp28=true',
      '--tmpfs',
      '/data:size=64m',
      'redis:7.4-alpine',
    ])
    this.docker([
      'run',
      '-d',
      '--name',
      this.vault,
      '--label',
      'persistent.wp28=true',
      '--tmpfs',
      '/vault/file:size=128m',
      '-e',
      'VAULT_DEV_ROOT_TOKEN_ID=wp28-vault-root-marker',
      '-p',
      '127.0.0.1::8200',
      'hashicorp/vault:1.20',
    ])
    const minioUrl = `http://127.0.0.1:${Number(this.docker(['port', this.minio, '9000/tcp']).split(':').at(-1))}`
    this.vaultBase = `http://127.0.0.1:${Number(this.docker(['port', this.vault, '8200/tcp']).split(':').at(-1))}`
    for (let i = 0; i < 120; i++) {
      if (
        (await fetch(`${minioUrl}/minio/health/ready`).catch(() => null))?.ok &&
        (await fetch(`${this.vaultBase}/v1/sys/health`).catch(() => null))?.ok
      )
        break
      await new Promise((r) => setTimeout(r, 250))
    }
    this.object = new S3CompatibleObjectStore({
      endpoint: minioUrl,
      bucket: 'wp28',
      accessKeyId: 'wp28access',
      secretAccessKey: 'wp28-secret-marker',
    })
    await this.object.ensureBucket()
    await this.admin.query(
      `CREATE TABLE wp28_index_rows(tenant_id text,object_id text,PRIMARY KEY(tenant_id,object_id))`,
    )
  }
  async vaultRequest(path: string, init: RequestInit = {}) {
    return fetch(`${this.vaultBase}/v1/${path}`, {
      ...init,
      headers: {
        'x-vault-token': 'wp28-vault-root-marker',
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  }
  async seedKey(tenantId: string, version = 1) {
    const key = randomBytes(32)
    await this.vaultRequest(`secret/data/${tenantId}/${version}`, {
      method: 'POST',
      body: JSON.stringify({ data: { key: key.toString('base64') } }),
    })
    this.keyVersions.set(tenantId, version)
    return key
  }
  adapters(): LifecycleAdapters {
    return {
      object: this.object,
      cache: {
        purgeTenant: async (tenantId) => {
          for (const key of this.docker(
            [
              'exec',
              this.redis,
              'redis-cli',
              '--scan',
              '--pattern',
              `tenant:${tenantId}:*`,
            ],
            true,
          )
            .split('\n')
            .filter(Boolean))
            this.docker(['exec', this.redis, 'redis-cli', 'DEL', key])
        },
      },
      index: {
        purgeTenant: async (tenantId) => {
          await this.admin.query(
            `DELETE FROM wp28_index_rows WHERE tenant_id=$1`,
            [tenantId],
          )
        },
        delete: async (objectId) => {
          await this.admin.query(
            `DELETE FROM wp28_index_rows WHERE object_id=$1`,
            [objectId],
          )
        },
      },
      kms: {
        key: async (tenantId, version) => {
          const response = await this.vaultRequest(
            `secret/data/${tenantId}/${version}`,
          )
          if (!response.ok) throw new Error('KMS_KEY_UNAVAILABLE')
          return Buffer.from(
            ((await response.json()) as any).data.data.key,
            'base64',
          )
        },
        destroy: async (tenantId, version) => {
          await this.vaultRequest(`secret/metadata/${tenantId}/${version}`, {
            method: 'DELETE',
          })
          this.keyVersions.delete(tenantId)
        },
      },
    }
  }
  async cleanup() {
    this.docker(['rm', '-f', '-v', this.minio, this.redis, this.vault], true)
    await super.cleanup()
  }
}
