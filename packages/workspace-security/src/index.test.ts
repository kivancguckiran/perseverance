import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ChunkedEnvelopeEncryption,
  CryptoError,
  DevSecretProvider,
  EncryptedBackupService,
  EncryptionBackfillRunner,
  EnvelopeEncryption,
  KataKubernetesRuntimeDriver,
  LocalKmsProvider,
  SecretLeaseManager,
  SecurityBoundaryError,
  WorkspaceNetworkPolicy,
  canonicalWorkspacePath,
  isDeniedNetworkAddress,
} from './index'

const scope = {
  tenantId: 'tenant-a',
  organizationId: 'org-a',
  workspaceId: 'workspace-a',
}
const context = {
  ...scope,
  recordType: 'raw_event' as const,
  recordId: 'event-1',
}

describe('workspace path isolation', () => {
  it('rejects traversal and symlink escape', () => {
    const root = mkdtempSync(join(tmpdir(), 'workspace-security-'))
    mkdirSync(join(root, 'safe'))
    writeFileSync(join(root, 'safe', 'file.txt'), 'ok')
    symlinkSync(tmpdir(), join(root, 'escape'))
    expect(canonicalWorkspacePath(root, 'safe/file.txt')).toBe(
      realpathSync(join(root, 'safe', 'file.txt')),
    )
    expect(() => canonicalWorkspacePath(root, '../outside')).toThrow(
      SecurityBoundaryError,
    )
    expect(() => canonicalWorkspacePath(root, 'escape')).toThrow(
      'SYMLINK_ESCAPE_DENIED',
    )
  })
})

describe('Kata runtime driver', () => {
  it('builds a micro-VM pod without host mounts or host namespaces', () => {
    const driver = new KataKubernetesRuntimeDriver({
      async apply() {},
      async remove() {},
      async runtimeClassExists() {
        return true
      },
    })
    const manifest = JSON.parse(
      driver.manifest({
        version: 1,
        ...scope,
        runtimeId: 'runtime-a',
        image: 'workspace-agent:test',
        cpuMillis: 1_000,
        memoryMiB: 2_048,
        encryptedVolume: {
          claimName: 'encrypted-workspace-a',
          storageClassName: 'encrypted-csi',
          sizeGiB: 20,
        },
        workloadServiceAccount: 'workspace-a',
      }),
    ) as Record<string, any>
    expect(manifest.spec.runtimeClassName).toBe('kata-qemu')
    expect(manifest.spec.hostNetwork).toBe(false)
    expect(manifest.spec.hostPID).toBe(false)
    expect(manifest.spec.hostIPC).toBe(false)
    expect(
      manifest.spec.volumes.some((volume: Record<string, unknown>) =>
        Boolean(volume.hostPath),
      ),
    ).toBe(false)
    expect(manifest.spec.containers[0].securityContext.privileged).toBe(false)
  })
})

describe('network isolation', () => {
  it('denies metadata, private, loopback and rebinding targets', async () => {
    expect(isDeniedNetworkAddress('169.254.169.254')).toBe(true)
    expect(isDeniedNetworkAddress('127.0.0.1')).toBe(true)
    expect(isDeniedNetworkAddress('10.0.0.2')).toBe(true)
    expect(isDeniedNetworkAddress('8.8.8.8')).toBe(false)
    let calls = 0
    const policy = new WorkspaceNetworkPolicy({
      async resolve() {
        calls++
        return calls === 1 ? ['8.8.8.8'] : ['127.0.0.1']
      },
    })
    policy.grant({
      ...scope,
      runtimeId: 'runtime-a',
      target: { protocol: 'https', hostname: 'example.com', port: 443 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: 'grant-1',
    })
    await expect(
      policy.authorize(
        { ...scope, runtimeId: 'runtime-a' },
        { protocol: 'https', hostname: 'example.com', port: 443 },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK_REBINDING_DENIED' })
  })

  it('keeps grants runtime and tenant scoped', async () => {
    const policy = new WorkspaceNetworkPolicy({
      async resolve() {
        return ['8.8.8.8']
      },
    })
    policy.grant({
      ...scope,
      runtimeId: 'runtime-a',
      target: { protocol: 'tls', hostname: 'registry.example', port: 443 },
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      idempotencyKey: 'grant-1',
    })
    await expect(
      policy.authorize(
        { ...scope, workspaceId: 'workspace-b', runtimeId: 'runtime-b' },
        { protocol: 'tls', hostname: 'registry.example', port: 443 },
      ),
    ).rejects.toMatchObject({ code: 'EGRESS_DEFAULT_DENY' })
  })
})

describe('secret leases', () => {
  it('cleans plaintext files on revoke and runtime cleanup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'secret-leases-'))
    writeFileSync(join(root, 'orphan-from-crash'), Buffer.from([9, 8, 7]), {
      mode: 0o600,
    })
    const manager = new SecretLeaseManager(
      new DevSecretProvider(new Map([['openai', Buffer.from([1, 2, 3, 4])]])),
      root,
    )
    expect(existsSync(join(root, 'orphan-from-crash'))).toBe(false)
    const identity = { ...scope, runtimeId: 'runtime-a', subject: 'agent' }
    const lease = await manager.issue(identity, 'openai', 5_000)
    expect(existsSync(lease.path)).toBe(true)
    manager.revoke(lease.leaseId)
    expect(existsSync(lease.path)).toBe(false)
    const second = await manager.issue(identity, 'openai', 5_000)
    manager.cleanup('runtime-a')
    expect(existsSync(second.path)).toBe(false)
  })
})

describe('envelope encryption', () => {
  it('fails closed for cross-tenant context, substitution and tampering', async () => {
    const kms = new LocalKmsProvider(Buffer.alloc(32, 7))
    const encryption = new EnvelopeEncryption(kms)
    const envelope = await encryption.encrypt(context, Buffer.from('secret'))
    expect(
      Buffer.from(await encryption.decrypt(context, envelope)).toString(),
    ).toBe('secret')
    await expect(
      encryption.decrypt({ ...context, tenantId: 'tenant-b' }, envelope),
    ).rejects.toBeInstanceOf(CryptoError)
    await expect(
      encryption.decrypt(context, {
        ...envelope,
        ciphertext: Buffer.from('modified').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'CIPHERTEXT_AUTHENTICATION_FAILED' })
    await expect(
      encryption.decrypt(context, {
        ...envelope,
        encryptedDek: {
          ...envelope.encryptedDek,
          keyVersion: '999',
        },
        keyVersion: '999',
      }),
    ).rejects.toMatchObject({ code: 'KMS_KEY_REVOKED_OR_MISSING' })
  })

  it('reads old and new key versions during rotation and rejects revoked keys', async () => {
    const kms = new LocalKmsProvider(Buffer.alloc(32, 1))
    const encryption = new EnvelopeEncryption(kms)
    const oldEnvelope = await encryption.encrypt(context, Buffer.from('old'))
    const newVersion = kms.rotate(Buffer.alloc(32, 2))
    const newEnvelope = await encryption.encrypt(context, Buffer.from('new'))
    expect(newEnvelope.keyVersion).toBe(newVersion)
    expect(
      Buffer.from(await encryption.decrypt(context, oldEnvelope)).toString(),
    ).toBe('old')
    kms.revokeKeyVersion(oldEnvelope.keyVersion)
    await expect(
      encryption.decrypt(context, oldEnvelope),
    ).rejects.toMatchObject({ code: 'KMS_KEY_REVOKED_OR_MISSING' })
  })

  it('crypto-erases a workspace', async () => {
    const kms = new LocalKmsProvider(Buffer.alloc(32, 3))
    const audit: string[] = []
    const encryption = new EnvelopeEncryption(kms, (event) =>
      audit.push(event.action),
    )
    const envelope = await encryption.encrypt(context, Buffer.from('secret'))
    await encryption.cryptoErase(scope)
    await expect(encryption.decrypt(context, envelope)).rejects.toMatchObject({
      code: 'WORKSPACE_CRYPTO_ERASED',
    })
    expect(audit).toEqual(['workspace.crypto_erased'])
  })

  it('backfills plaintext idempotently without returning plaintext metadata', async () => {
    const encryption = new EnvelopeEncryption(
      new LocalKmsProvider(Buffer.alloc(32, 8)),
    )
    let plaintext: Uint8Array | null = Buffer.from('legacy prompt')
    let envelope: Awaited<ReturnType<EnvelopeEncryption['encrypt']>> | null =
      null
    const runner = new EncryptionBackfillRunner(encryption, {
      async readBatch({ afterId }) {
        if (afterId) return []
        return [
          {
            context: { ...context, recordType: 'prompt' },
            plaintext,
            envelope,
          },
        ]
      },
      async replacePlaintext(input) {
        if (!plaintext) return 'already_encrypted'
        envelope = input.envelope
        plaintext.fill(0)
        plaintext = null
        return 'updated'
      },
    })
    expect(await runner.run()).toEqual({
      encrypted: 1,
      alreadyEncrypted: 0,
      conflicts: 0,
    })
    expect(envelope).not.toBeNull()
    expect(await runner.run()).toEqual({
      encrypted: 0,
      alreadyEncrypted: 1,
      conflicts: 0,
    })
  })
})

describe('chunked encryption and backup restore', () => {
  it('authenticates every chunk and rejects cross-tenant restore', async () => {
    const crypto = new ChunkedEnvelopeEncryption(
      new LocalKmsProvider(Buffer.alloc(32, 4)),
      1024,
    )
    const data = Buffer.alloc(4097, 9)
    const encrypted = await crypto.encrypt(
      { ...scope, recordType: 'artifact', recordId: 'artifact-1' },
      data,
    )
    expect(encrypted.chunks).toHaveLength(5)
    expect(
      Buffer.from(
        await crypto.decrypt(
          { ...scope, recordType: 'artifact', recordId: 'artifact-1' },
          encrypted,
        ),
      ).equals(data),
    ).toBe(true)
    const tampered = structuredClone(encrypted)
    tampered.chunks[1]!.authenticationTag = Buffer.alloc(16).toString('base64')
    await expect(
      crypto.decrypt(
        { ...scope, recordType: 'artifact', recordId: 'artifact-1' },
        tampered,
      ),
    ).rejects.toMatchObject({ code: 'CHUNK_AUTHENTICATION_FAILED' })

    const backups = new EncryptedBackupService(crypto)
    const backup = await backups.create(scope, 'backup-1', data)
    await expect(
      backups.restore(
        scope,
        { ...scope, tenantId: 'tenant-b' },
        'backup-1',
        backup,
      ),
    ).rejects.toMatchObject({ code: 'CROSS_TENANT_RESTORE_DENIED' })
  })

  it('streams bounded chunks through a storage sink/source', async () => {
    const crypto = new ChunkedEnvelopeEncryption(
      new LocalKmsProvider(Buffer.alloc(32, 6)),
      1024,
    )
    const encryptedChunks = new Map<number, Uint8Array>()
    const data = Buffer.alloc(5_000, 4)
    async function* source() {
      yield data.subarray(0, 700)
      yield data.subarray(700, 3_333)
      yield data.subarray(3_333)
    }
    const manifest = await crypto.encryptToSink(
      { ...scope, recordType: 'attachment', recordId: 'attachment-1' },
      data.byteLength,
      source(),
      {
        async write(index, ciphertext) {
          expect(ciphertext.byteLength).toBeLessThanOrEqual(1024)
          encryptedChunks.set(index, Uint8Array.from(ciphertext))
        },
      },
    )
    const restored: Buffer[] = []
    for await (const chunk of crypto.decryptFromSource(
      { ...scope, recordType: 'attachment', recordId: 'attachment-1' },
      manifest,
      {
        async read(index) {
          return encryptedChunks.get(index)!
        },
      },
    ))
      restored.push(Buffer.from(chunk))
    expect(Buffer.concat(restored).equals(data)).toBe(true)
  })
})

describe('fixture user content key chain', () => {
  const userScope = {
    ...scope,
    userId: 'usr_1',
    wrapType: 'password' as const,
  }

  it('derives deterministic keks and round-trips the content key', async () => {
    const {
      createUserKdfParams,
      deriveUserKek,
      generateContentKey,
      unwrapContentKey,
      wrapContentKey,
      USER_KEK_HKDF_INFO,
    } = await import('./index')
    const params = createUserKdfParams(USER_KEK_HKDF_INFO)
    const kek = await deriveUserKek('correct horse battery', params)
    const again = await deriveUserKek('correct horse battery', params)
    expect(kek.equals(again)).toBe(true)
    const other = await deriveUserKek('wrong password 123', params)
    expect(kek.equals(other)).toBe(false)
    const contentKey = generateContentKey()
    const wrapped = wrapContentKey(contentKey, kek, userScope)
    expect(unwrapContentKey(wrapped, kek, userScope).equals(contentKey)).toBe(
      true,
    )
    expect(() => unwrapContentKey(wrapped, other, userScope)).toThrowError(
      /CONTENT_KEY_UNWRAP_FAILED/,
    )
    expect(() =>
      unwrapContentKey(wrapped, kek, { ...userScope, wrapType: 'recovery' }),
    ).toThrowError(/CONTENT_KEY_UNWRAP_FAILED/)
  })

  const passwordHashFixture =
    '$argon2id$v=19$m=65536,t=3,p=1$qhZ9Jxyvrvx98vVXMWUKjg$' +
    '64IWpmCT0LpuP/d57JPLst4pl/LV+3AUzXXAEQREFoM'

  it('hashes passwords with production argon2id parameters', async () => {
    const { hashUserPassword } = await import('./index')
    const hash = await hashUserPassword('sixteen-char-secret')
    expect(hash.startsWith('$argon2id$')).toBe(true)
    await expect(hashUserPassword('short')).rejects.toThrowError(
      /PASSWORD_TOO_SHORT/,
    )
  })

  it('verifies a matching production argon2id hash', async () => {
    const { verifyUserPassword } = await import('./index')
    expect(
      await verifyUserPassword('sixteen-char-secret', passwordHashFixture),
    ).toBe(true)
  })

  it('rejects a mismatching production argon2id hash', async () => {
    const { verifyUserPassword } = await import('./index')
    expect(
      await verifyUserPassword('not-the-secret-1', passwordHashFixture),
    ).toBe(false)
  })

  it('runs timing equalization but rejects a missing password hash', async () => {
    const { verifyUserPassword } = await import('./index')
    expect(await verifyUserPassword('anything-at-all-1', null)).toBe(false)
  })

  it('generates verifiable one-time recovery keys', async () => {
    const { generateRecoveryKey, recoveryKeyMatches, recoveryKeySha256 } =
      await import('./index')
    const recoveryKey = generateRecoveryKey()
    expect(recoveryKey.startsWith('RK1-')).toBe(true)
    const stored = recoveryKeySha256(recoveryKey)
    expect(recoveryKeyMatches(recoveryKey, stored)).toBe(true)
    expect(
      recoveryKeyMatches(
        recoveryKey.toLowerCase().replaceAll('-', ' '),
        stored,
      ),
    ).toBe(true)
    expect(recoveryKeyMatches(generateRecoveryKey(), stored)).toBe(false)
  })

  it('binds envelope encryption to the user content key provider', async () => {
    const { EnvelopeEncryption, UserContentKmsProvider, generateContentKey } =
      await import('./index')
    const contentKey = generateContentKey()
    const kms = new UserContentKmsProvider(contentKey, '1')
    const crypto = new EnvelopeEncryption(kms)
    const envelope = await crypto.encrypt(
      { ...scope, recordType: 'prompt', recordId: 'run_1' },
      new TextEncoder().encode('gizli mesaj'),
    )
    const decrypted = await crypto.decrypt(
      { ...scope, recordType: 'prompt', recordId: 'run_1' },
      envelope,
    )
    expect(new TextDecoder().decode(decrypted)).toBe('gizli mesaj')
    const otherKms = new UserContentKmsProvider(generateContentKey(), '1')
    const otherCrypto = new EnvelopeEncryption(otherKms)
    await expect(
      otherCrypto.decrypt(
        { ...scope, recordType: 'prompt', recordId: 'run_1' },
        envelope,
      ),
    ).rejects.toThrowError()
  })

  it('issues, refreshes and revokes in-memory content key leases', async () => {
    const { ContentKeyLeaseManager, generateContentKey } =
      await import('./index')
    let now = 1_000
    const audits: string[] = []
    const leases = new ContentKeyLeaseManager({
      ttlMs: 100,
      now: () => now,
      audit: (event) => audits.push(event.action),
    })
    const contentKey = generateContentKey()
    leases.issue({
      scope,
      userId: 'usr_1',
      keyVersion: '1',
      contentKey,
    })
    const held = leases.acquire(scope.workspaceId)
    expect(held?.contentKey.equals(contentKey)).toBe(true)
    now += 99
    expect(leases.acquire(scope.workspaceId)).not.toBeNull()
    now += 101
    expect(leases.acquire(scope.workspaceId)).toBeNull()
    leases.issue({ scope, userId: 'usr_1', keyVersion: '1', contentKey })
    expect(leases.revoke(scope.workspaceId)).toBe(true)
    expect(leases.acquire(scope.workspaceId)).toBeNull()
    expect(audits).toEqual([
      'secret.lease_issued',
      'secret.lease_revoked',
      'secret.lease_issued',
      'secret.lease_revoked',
    ])
  })
})
