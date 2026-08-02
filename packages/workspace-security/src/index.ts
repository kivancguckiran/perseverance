import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto'
import { argon2Verify, argon2id } from 'hash-wasm'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isIP } from 'node:net'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const WORKSPACE_RUNTIME_DRIVER_VERSION = 1 as const
export const ENVELOPE_FORMAT_VERSION = 1 as const
export const CHUNKED_ENCRYPTION_FORMAT_VERSION = 1 as const
export const NETWORK_POLICY_VERSION = 1 as const
export const SECRET_LEASE_VERSION = 1 as const

export type IsolationLevel = 'development_only' | 'container' | 'microvm'

export interface WorkspaceSecurityScope {
  tenantId: string
  organizationId: string
  workspaceId: string
}

export interface WorkspaceRuntimeSpecV1 extends WorkspaceSecurityScope {
  version: typeof WORKSPACE_RUNTIME_DRIVER_VERSION
  runtimeId: string
  image: string
  cpuMillis: number
  memoryMiB: number
  encryptedVolume: {
    claimName: string
    storageClassName: string
    sizeGiB: number
  }
  workloadServiceAccount: string
}

export interface WorkspaceRuntimeDescriptorV1 extends WorkspaceSecurityScope {
  version: typeof WORKSPACE_RUNTIME_DRIVER_VERSION
  runtimeId: string
  backend: 'local-process' | 'kata-kubernetes'
  isolationLevel: IsolationLevel
  encryptedVolume: boolean
  hostPathMounts: false
  egressDefaultDeny: true
}

export interface WorkspaceRuntimeDriverV1 {
  readonly version: typeof WORKSPACE_RUNTIME_DRIVER_VERSION
  readonly backend: WorkspaceRuntimeDescriptorV1['backend']
  readonly isolationLevel: IsolationLevel
  provision(spec: WorkspaceRuntimeSpecV1): Promise<WorkspaceRuntimeDescriptorV1>
  destroy(runtime: WorkspaceRuntimeDescriptorV1): Promise<void>
  readiness(): Promise<{
    ready: boolean
    code: string | null
    backend: WorkspaceRuntimeDescriptorV1['backend']
    isolationLevel: IsolationLevel
  }>
}

export class LocalProcessRuntimeDriver implements WorkspaceRuntimeDriverV1 {
  readonly version = WORKSPACE_RUNTIME_DRIVER_VERSION
  readonly backend = 'local-process' as const
  readonly isolationLevel = 'development_only' as const

  async provision(
    spec: WorkspaceRuntimeSpecV1,
  ): Promise<WorkspaceRuntimeDescriptorV1> {
    return {
      version: this.version,
      tenantId: spec.tenantId,
      organizationId: spec.organizationId,
      workspaceId: spec.workspaceId,
      runtimeId: spec.runtimeId,
      backend: this.backend,
      isolationLevel: this.isolationLevel,
      encryptedVolume: false,
      hostPathMounts: false,
      egressDefaultDeny: true,
    }
  }

  async destroy(): Promise<void> {}

  async readiness() {
    return {
      ready: true,
      code: 'LOCAL_RUNTIME_NOT_PRODUCTION_ISOLATION',
      backend: this.backend,
      isolationLevel: this.isolationLevel,
    }
  }
}

export interface KataCommandRunner {
  apply(manifest: string): Promise<void>
  remove(runtimeId: string): Promise<void>
  runtimeClassExists(name: string): Promise<boolean>
}

function kubernetesName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized || normalized.length > 63)
    throw new SecurityBoundaryError('INVALID_RUNTIME_ID')
  return normalized
}

export class KataKubernetesRuntimeDriver implements WorkspaceRuntimeDriverV1 {
  readonly version = WORKSPACE_RUNTIME_DRIVER_VERSION
  readonly backend = 'kata-kubernetes' as const
  readonly isolationLevel = 'microvm' as const
  readonly runner: KataCommandRunner
  readonly runtimeClassName: string

  constructor(runner: KataCommandRunner, runtimeClassName = 'kata-qemu') {
    this.runner = runner
    this.runtimeClassName = runtimeClassName
  }

  manifest(spec: WorkspaceRuntimeSpecV1): string {
    const runtimeName = kubernetesName(spec.runtimeId)
    const labels = {
      'persistent-codex.io/runtime-id': spec.runtimeId,
      'persistent-codex.io/tenant-hash': scopeHash(spec.tenantId),
      'persistent-codex.io/organization-hash': scopeHash(spec.organizationId),
      'persistent-codex.io/workspace-hash': scopeHash(spec.workspaceId),
    }
    return JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { name: runtimeName, labels },
      spec: {
        runtimeClassName: this.runtimeClassName,
        automountServiceAccountToken: false,
        serviceAccountName: spec.workloadServiceAccount,
        hostNetwork: false,
        hostPID: false,
        hostIPC: false,
        enableServiceLinks: false,
        restartPolicy: 'Never',
        securityContext: {
          runAsNonRoot: true,
          seccompProfile: { type: 'RuntimeDefault' },
        },
        containers: [
          {
            name: 'workspace-agent',
            image: spec.image,
            securityContext: {
              allowPrivilegeEscalation: false,
              privileged: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            resources: {
              limits: {
                cpu: `${spec.cpuMillis}m`,
                memory: `${spec.memoryMiB}Mi`,
              },
              requests: {
                cpu: `${spec.cpuMillis}m`,
                memory: `${spec.memoryMiB}Mi`,
              },
            },
            volumeMounts: [
              {
                name: 'workspace',
                mountPath: '/workspace',
                readOnly: false,
              },
              {
                name: 'runtime-tmp',
                mountPath: '/run/secrets',
                readOnly: false,
              },
            ],
          },
        ],
        volumes: [
          {
            name: 'workspace',
            persistentVolumeClaim: {
              claimName: spec.encryptedVolume.claimName,
              readOnly: false,
            },
          },
          {
            name: 'runtime-tmp',
            emptyDir: { medium: 'Memory', sizeLimit: '16Mi' },
          },
        ],
      },
    })
  }

  async provision(
    spec: WorkspaceRuntimeSpecV1,
  ): Promise<WorkspaceRuntimeDescriptorV1> {
    if (!(await this.runner.runtimeClassExists(this.runtimeClassName)))
      throw new SecurityBoundaryError('KATA_RUNTIME_CLASS_UNAVAILABLE')
    await this.runner.apply(this.manifest(spec))
    return {
      version: this.version,
      tenantId: spec.tenantId,
      organizationId: spec.organizationId,
      workspaceId: spec.workspaceId,
      runtimeId: spec.runtimeId,
      backend: this.backend,
      isolationLevel: this.isolationLevel,
      encryptedVolume: true,
      hostPathMounts: false,
      egressDefaultDeny: true,
    }
  }

  async destroy(runtime: WorkspaceRuntimeDescriptorV1): Promise<void> {
    await this.runner.remove(runtime.runtimeId)
  }

  async readiness() {
    const ready = await this.runner.runtimeClassExists(this.runtimeClassName)
    return {
      ready,
      code: ready ? null : 'KATA_RUNTIME_CLASS_UNAVAILABLE',
      backend: this.backend,
      isolationLevel: this.isolationLevel,
    }
  }
}

export class SecurityBoundaryError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.code = code
    this.name = 'SecurityBoundaryError'
  }
}

const SAFE_SCOPE = /^[A-Za-z0-9._:-]{1,160}$/

function requireScopePart(value: string, name: string): string {
  if (!SAFE_SCOPE.test(value) || value === '.' || value === '..')
    throw new SecurityBoundaryError(
      'INVALID_SECURITY_SCOPE',
      `${name} is invalid`,
    )
  return value
}

function scopeHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

export function canonicalWorkspacePath(
  workspaceRoot: string,
  requestedPath: string,
): string {
  if (!isAbsolute(workspaceRoot))
    throw new SecurityBoundaryError('WORKSPACE_ROOT_NOT_ABSOLUTE')
  const root = realpathSync(workspaceRoot)
  if (root === '/proc' || root.startsWith('/proc/'))
    throw new SecurityBoundaryError('SPECIAL_FILESYSTEM_DENIED')
  if (root === '/sys' || root.startsWith('/sys/'))
    throw new SecurityBoundaryError('SPECIAL_FILESYSTEM_DENIED')
  const candidate = resolve(root, requestedPath)
  const rel = relative(root, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`))
    throw new SecurityBoundaryError('PATH_TRAVERSAL_DENIED')

  const rootDevice = statSync(root).dev
  let cursor = root
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    const stat = lstatSync(cursor)
    if (stat.isSymbolicLink())
      throw new SecurityBoundaryError('SYMLINK_ESCAPE_DENIED')
    if (stat.dev !== rootDevice)
      throw new SecurityBoundaryError('MOUNT_ESCAPE_DENIED')
  }
  const canonical = realpathSync(candidate)
  const canonicalRel = relative(root, canonical)
  if (canonicalRel === '..' || canonicalRel.startsWith(`..${sep}`))
    throw new SecurityBoundaryError('PATH_ESCAPE_DENIED')
  if (
    canonical === '/proc' ||
    canonical.startsWith('/proc/') ||
    canonical === '/sys' ||
    canonical.startsWith('/sys/')
  )
    throw new SecurityBoundaryError('SPECIAL_FILESYSTEM_DENIED')
  return canonical
}

export interface NetworkTarget {
  protocol: 'tcp' | 'tls' | 'https'
  hostname: string
  port: number
}

export interface NetworkGrantV1 extends WorkspaceSecurityScope {
  version: typeof NETWORK_POLICY_VERSION
  grantId: string
  runtimeId: string
  target: NetworkTarget
  expiresAt: string
  idempotencyKey: string
}

export interface NetworkDecisionAudit {
  tenantId: string
  organizationId: string
  workspaceId: string
  runtimeId: string
  hostname: string
  port: number
  outcome: 'allow' | 'deny'
  reasonCode: string
}

export interface HostResolver {
  resolve(hostname: string): Promise<string[]>
}

function ipv4Number(ip: string): number {
  return (
    ip
      .split('.')
      .map(Number)
      .reduce((value, octet) => (value << 8) + octet, 0) >>> 0
  )
}

function inCidr(ip: string, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4Number(ip) & mask) === (ipv4Number(base) & mask)
}

export function isDeniedNetworkAddress(ip: string): boolean {
  if (isIP(ip) === 4)
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) => inCidr(ip, String(base), Number(prefix)))
  if (isIP(ip) === 6) {
    const normalized = ip.toLowerCase()
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff')
    )
  }
  return true
}

export class WorkspaceNetworkPolicy {
  readonly #grants = new Map<string, NetworkGrantV1>()
  readonly resolver: HostResolver
  readonly audit: (decision: NetworkDecisionAudit) => void
  readonly now: () => Date

  constructor(
    resolver: HostResolver,
    audit: (decision: NetworkDecisionAudit) => void = () => {},
    now: () => Date = () => new Date(),
  ) {
    this.resolver = resolver
    this.audit = audit
    this.now = now
  }

  grant(input: Omit<NetworkGrantV1, 'version' | 'grantId'>): NetworkGrantV1 {
    const key = JSON.stringify([
      input.tenantId,
      input.organizationId,
      input.workspaceId,
      input.runtimeId,
      input.idempotencyKey,
    ])
    const existing = this.#grants.get(key)
    if (existing) {
      if (
        JSON.stringify(existing.target) !== JSON.stringify(input.target) ||
        existing.expiresAt !== input.expiresAt
      )
        throw new SecurityBoundaryError('NETWORK_GRANT_IDEMPOTENCY_CONFLICT')
      return existing
    }
    const grant = {
      ...input,
      version: NETWORK_POLICY_VERSION,
      grantId: `net_${randomUUID()}`,
    }
    this.#grants.set(key, grant)
    return grant
  }

  async authorize(
    scope: WorkspaceSecurityScope & { runtimeId: string },
    target: NetworkTarget,
  ): Promise<{ address: string; grantId: string }> {
    const grants = [...this.#grants.values()].filter(
      (grant) =>
        grant.tenantId === scope.tenantId &&
        grant.organizationId === scope.organizationId &&
        grant.workspaceId === scope.workspaceId &&
        grant.runtimeId === scope.runtimeId &&
        grant.target.hostname === target.hostname &&
        grant.target.port === target.port &&
        grant.target.protocol === target.protocol &&
        Date.parse(grant.expiresAt) > this.now().getTime(),
    )
    if (grants.length === 0)
      return this.#deny(scope, target, 'EGRESS_DEFAULT_DENY')

    const firstResolution = await this.resolver.resolve(target.hostname)
    if (
      firstResolution.length === 0 ||
      firstResolution.some(isDeniedNetworkAddress)
    )
      return this.#deny(scope, target, 'NETWORK_ADDRESS_DENIED')

    const connectionResolution = await this.resolver.resolve(target.hostname)
    if (
      connectionResolution.length === 0 ||
      connectionResolution.some(isDeniedNetworkAddress)
    )
      return this.#deny(scope, target, 'NETWORK_REBINDING_DENIED')
    const first = new Set(firstResolution)
    if (!connectionResolution.every((address) => first.has(address)))
      return this.#deny(scope, target, 'NETWORK_REBINDING_DENIED')

    this.audit({
      ...scope,
      hostname: target.hostname,
      port: target.port,
      outcome: 'allow',
      reasonCode: 'SCOPED_NETWORK_GRANT',
    })
    return { address: connectionResolution[0]!, grantId: grants[0]!.grantId }
  }

  #deny(
    scope: WorkspaceSecurityScope & { runtimeId: string },
    target: NetworkTarget,
    reasonCode: string,
  ): never {
    this.audit({
      ...scope,
      hostname: target.hostname,
      port: target.port,
      outcome: 'deny',
      reasonCode,
    })
    throw new SecurityBoundaryError(reasonCode)
  }
}

export interface WorkloadIdentity extends WorkspaceSecurityScope {
  runtimeId: string
  subject: string
}

export interface SecretProvider {
  readonly name: string
  readonly production: boolean
  read(identity: WorkloadIdentity, secretRef: string): Promise<Uint8Array>
}

export interface AwsSecretsManagerClientPort {
  readSecret(input: {
    identity: WorkloadIdentity
    secretRef: string
  }): Promise<Uint8Array>
}

export class AwsSecretsManagerProvider implements SecretProvider {
  readonly name = 'aws-secrets-manager'
  readonly production = true
  readonly client: AwsSecretsManagerClientPort

  constructor(client: AwsSecretsManagerClientPort) {
    this.client = client
  }

  async read(identity: WorkloadIdentity, secretRef: string) {
    return this.client.readSecret({ identity, secretRef })
  }
}

export interface SecretLeaseV1 {
  version: typeof SECRET_LEASE_VERSION
  leaseId: string
  identity: WorkloadIdentity
  secretRefHash: string
  expiresAt: string
  path: string
  status: 'active' | 'revoked' | 'expired'
}

export interface SecretLeaseAudit {
  identity: WorkloadIdentity
  leaseId: string
  secretRefHash: string
  action: 'issued' | 'renewed' | 'revoked' | 'expired'
}

export class DevSecretProvider implements SecretProvider {
  readonly name = 'development-memory'
  readonly production = false
  readonly values: ReadonlyMap<string, Uint8Array>
  constructor(values: ReadonlyMap<string, Uint8Array>) {
    this.values = values
  }
  async read(_identity: WorkloadIdentity, secretRef: string) {
    const value = this.values.get(secretRef)
    if (!value) throw new SecurityBoundaryError('SECRET_NOT_FOUND')
    return Uint8Array.from(value)
  }
}

export class SecretLeaseManager {
  readonly #leases = new Map<string, SecretLeaseV1>()
  readonly #root: string
  readonly provider: SecretProvider
  readonly now: () => Date
  readonly audit: (event: SecretLeaseAudit) => void

  constructor(
    provider: SecretProvider,
    root: string,
    now: () => Date = () => new Date(),
    audit: (event: SecretLeaseAudit) => void = () => {},
  ) {
    this.provider = provider
    this.now = now
    this.audit = audit
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.#root = realpathSync(root)
    for (const entry of readdirSync(this.#root))
      rmSync(resolve(this.#root, entry), { force: true, recursive: true })
    this.cleanup()
  }

  async issue(
    identity: WorkloadIdentity,
    secretRef: string,
    ttlMs: number,
  ): Promise<SecretLeaseV1> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000)
      throw new SecurityBoundaryError('INVALID_SECRET_LEASE_TTL')
    const leaseId = `lease_${randomUUID()}`
    const directory = resolve(this.#root, scopeHash(identity.runtimeId))
    const path = resolve(directory, leaseId)
    this.#assertPath(path)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const value = await this.provider.read(identity, secretRef)
    const fd = openSync(path, 'wx', 0o600)
    try {
      writeFileSync(fd, value)
    } finally {
      closeSync(fd)
      value.fill(0)
    }
    const lease: SecretLeaseV1 = {
      version: SECRET_LEASE_VERSION,
      leaseId,
      identity,
      secretRefHash: scopeHash(secretRef),
      expiresAt: new Date(this.now().getTime() + ttlMs).toISOString(),
      path,
      status: 'active',
    }
    this.#leases.set(leaseId, lease)
    this.audit({
      identity,
      leaseId,
      secretRefHash: lease.secretRefHash,
      action: 'issued',
    })
    return lease
  }

  async renew(leaseId: string, ttlMs: number): Promise<SecretLeaseV1> {
    const lease = this.#requireActive(leaseId)
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000)
      throw new SecurityBoundaryError('INVALID_SECRET_LEASE_TTL')
    lease.expiresAt = new Date(this.now().getTime() + ttlMs).toISOString()
    this.audit({
      identity: lease.identity,
      leaseId,
      secretRefHash: lease.secretRefHash,
      action: 'renewed',
    })
    return lease
  }

  revoke(leaseId: string): void {
    const lease = this.#leases.get(leaseId)
    if (!lease) return
    rmSync(lease.path, { force: true })
    lease.status = 'revoked'
    this.audit({
      identity: lease.identity,
      leaseId,
      secretRefHash: lease.secretRefHash,
      action: 'revoked',
    })
  }

  cleanup(runtimeId?: string): number {
    let cleaned = 0
    for (const lease of this.#leases.values()) {
      if (runtimeId && lease.identity.runtimeId !== runtimeId) continue
      if (
        runtimeId ||
        lease.status !== 'active' ||
        Date.parse(lease.expiresAt) <= this.now().getTime()
      ) {
        rmSync(lease.path, { force: true })
        if (lease.status === 'active') {
          lease.status = 'expired'
          this.audit({
            identity: lease.identity,
            leaseId: lease.leaseId,
            secretRefHash: lease.secretRefHash,
            action: 'expired',
          })
        }
        cleaned++
      }
    }
    if (runtimeId) {
      rmSync(resolve(this.#root, scopeHash(runtimeId)), {
        force: true,
        recursive: true,
      })
    }
    return cleaned
  }

  #requireActive(leaseId: string): SecretLeaseV1 {
    const lease = this.#leases.get(leaseId)
    if (!lease || lease.status !== 'active')
      throw new SecurityBoundaryError('SECRET_LEASE_INACTIVE')
    if (Date.parse(lease.expiresAt) <= this.now().getTime()) {
      rmSync(lease.path, { force: true })
      lease.status = 'expired'
      this.audit({
        identity: lease.identity,
        leaseId,
        secretRefHash: lease.secretRefHash,
        action: 'expired',
      })
      throw new SecurityBoundaryError('SECRET_LEASE_EXPIRED')
    }
    return lease
  }

  #assertPath(path: string): void {
    const rel = relative(this.#root, path)
    if (rel === '..' || rel.startsWith(`..${sep}`))
      throw new SecurityBoundaryError('SECRET_PATH_ESCAPE')
  }
}

export interface EncryptionContextV1 extends WorkspaceSecurityScope {
  recordType:
    | 'prompt'
    | 'model_output'
    | 'raw_event'
    | 'artifact'
    | 'attachment'
    | 'backup'
    | 'corpus_snapshot'
    | 'push_subscription'
    | 'provider_credential'
  recordId: string
  additionalAuthenticatedData?: Readonly<Record<string, string>>
}

export interface WrappedKey {
  provider: string
  keyId: string
  keyVersion: string
  ciphertext: string
}

export interface KmsProvider {
  readonly name: string
  readonly production: boolean
  currentKeyVersion(scope: WorkspaceSecurityScope): Promise<string>
  wrapKey(
    scope: WorkspaceSecurityScope,
    plaintextDek: Uint8Array,
    keyVersion: string,
  ): Promise<WrappedKey>
  unwrapKey(
    scope: WorkspaceSecurityScope,
    wrapped: WrappedKey,
  ): Promise<Uint8Array>
  revokeWorkspace(scope: WorkspaceSecurityScope): Promise<void>
}

export class CryptoError extends Error {
  readonly code: string
  constructor(code: string, message = code) {
    super(message)
    this.code = code
    this.name = 'CryptoError'
  }
}

function canonicalContext(context: EncryptionContextV1): Buffer {
  for (const [name, value] of Object.entries(context))
    if (name !== 'additionalAuthenticatedData') requireScopePart(value, name)
  const base = [
    ENVELOPE_FORMAT_VERSION,
    context.tenantId,
    context.organizationId,
    context.workspaceId,
    context.recordType,
    context.recordId,
  ]
  if (!context.additionalAuthenticatedData)
    return Buffer.from(JSON.stringify(base))
  const additional = Object.entries(context.additionalAuthenticatedData)
    .map(([name, value]) => {
      requireScopePart(name, 'additionalAuthenticatedData key')
      if (
        typeof value !== 'string' ||
        value.length < 1 ||
        value.length > 2_048 ||
        value.includes('\0')
      )
        throw new SecurityBoundaryError(
          'INVALID_ENCRYPTION_CONTEXT_AAD',
          'Additional authenticated data is invalid',
        )
      return [name, value] as const
    })
    .sort(([left], [right]) => left.localeCompare(right))
  return Buffer.from(JSON.stringify([...base, additional]))
}

function workspaceContext(scope: WorkspaceSecurityScope): Buffer {
  return Buffer.from(
    JSON.stringify([
      'workspace-kek-context-v1',
      requireScopePart(scope.tenantId, 'tenantId'),
      requireScopePart(scope.organizationId, 'organizationId'),
      requireScopePart(scope.workspaceId, 'workspaceId'),
    ]),
  )
}

export class LocalKmsProvider implements KmsProvider {
  readonly name = 'local-memory'
  readonly production = false
  readonly #keys = new Map<string, Buffer>()
  readonly #revoked = new Set<string>()
  #currentVersion = '1'

  constructor(seed = randomBytes(32)) {
    if (seed.byteLength !== 32) throw new CryptoError('INVALID_LOCAL_KEK')
    this.#keys.set(this.#currentVersion, Buffer.from(seed))
  }

  rotate(seed = randomBytes(32)): string {
    const version = String(Number(this.#currentVersion) + 1)
    this.#keys.set(version, Buffer.from(seed))
    this.#currentVersion = version
    return version
  }

  revokeKeyVersion(version: string): void {
    this.#keys.delete(version)
  }

  async currentKeyVersion(scope: WorkspaceSecurityScope) {
    this.#assertWorkspace(scope)
    return this.#currentVersion
  }

  async wrapKey(
    scope: WorkspaceSecurityScope,
    plaintextDek: Uint8Array,
    keyVersion: string,
  ): Promise<WrappedKey> {
    this.#assertWorkspace(scope)
    const key = this.#keys.get(keyVersion)
    if (!key) throw new CryptoError('KMS_KEY_MISSING')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, nonce)
    cipher.setAAD(workspaceContext(scope))
    const ciphertext = Buffer.concat([
      cipher.update(plaintextDek),
      cipher.final(),
    ])
    return {
      provider: this.name,
      keyId: 'development-only',
      keyVersion,
      ciphertext: Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString('base64'),
    }
  }

  async unwrapKey(
    scope: WorkspaceSecurityScope,
    wrapped: WrappedKey,
  ): Promise<Uint8Array> {
    this.#assertWorkspace(scope)
    if (wrapped.provider !== this.name)
      throw new CryptoError('KMS_PROVIDER_MISMATCH')
    const key = this.#keys.get(wrapped.keyVersion)
    if (!key) throw new CryptoError('KMS_KEY_REVOKED_OR_MISSING')
    const bytes = Buffer.from(wrapped.ciphertext, 'base64')
    if (bytes.length < 29) throw new CryptoError('WRAPPED_KEY_INVALID')
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        bytes.subarray(0, 12),
      )
      decipher.setAAD(workspaceContext(scope))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ])
    } catch {
      throw new CryptoError('WRAPPED_KEY_AUTHENTICATION_FAILED')
    }
  }

  async revokeWorkspace(scope: WorkspaceSecurityScope): Promise<void> {
    this.#revoked.add(this.#workspaceKey(scope))
  }

  #workspaceKey(scope: WorkspaceSecurityScope): string {
    return createHash('sha256').update(workspaceContext(scope)).digest('hex')
  }

  #assertWorkspace(scope: WorkspaceSecurityScope): void {
    if (this.#revoked.has(this.#workspaceKey(scope)))
      throw new CryptoError('WORKSPACE_CRYPTO_ERASED')
  }
}

export interface AwsKmsClientPort {
  encrypt(input: {
    keyId: string
    keyVersion: string
    plaintext: Uint8Array
    encryptionContext: Record<string, string>
  }): Promise<Uint8Array>
  decrypt(input: {
    ciphertext: Uint8Array
    encryptionContext: Record<string, string>
    keyId: string
  }): Promise<Uint8Array>
  scheduleWorkspaceErasure(scope: WorkspaceSecurityScope): Promise<void>
}

export class AwsKmsProvider implements KmsProvider {
  readonly name = 'aws-kms'
  readonly production = true
  readonly client: AwsKmsClientPort
  readonly keyId: string
  readonly keyVersion: string
  constructor(client: AwsKmsClientPort, keyId: string, keyVersion: string) {
    this.client = client
    this.keyId = keyId
    this.keyVersion = keyVersion
  }
  async currentKeyVersion() {
    return this.keyVersion
  }
  async wrapKey(
    scope: WorkspaceSecurityScope,
    plaintextDek: Uint8Array,
    keyVersion: string,
  ): Promise<WrappedKey> {
    const ciphertext = await this.client.encrypt({
      keyId: this.keyId,
      keyVersion,
      plaintext: plaintextDek,
      encryptionContext: kmsContext(scope),
    })
    return {
      provider: this.name,
      keyId: this.keyId,
      keyVersion,
      ciphertext: Buffer.from(ciphertext).toString('base64'),
    }
  }
  async unwrapKey(scope: WorkspaceSecurityScope, wrapped: WrappedKey) {
    if (wrapped.provider !== this.name || wrapped.keyId !== this.keyId)
      throw new CryptoError('KMS_KEY_SUBSTITUTION_DENIED')
    return this.client.decrypt({
      ciphertext: Buffer.from(wrapped.ciphertext, 'base64'),
      encryptionContext: kmsContext(scope),
      keyId: this.keyId,
    })
  }
  async revokeWorkspace(scope: WorkspaceSecurityScope) {
    await this.client.scheduleWorkspaceErasure(scope)
  }
}

function kmsContext(scope: WorkspaceSecurityScope): Record<string, string> {
  return {
    tenantId: requireScopePart(scope.tenantId, 'tenantId'),
    organizationId: requireScopePart(scope.organizationId, 'organizationId'),
    workspaceId: requireScopePart(scope.workspaceId, 'workspaceId'),
    purpose: 'perseverance-envelope-v1',
  }
}

export interface EnvelopeV1 {
  formatVersion: typeof ENVELOPE_FORMAT_VERSION
  algorithm: 'AES-256-GCM'
  keyVersion: string
  encryptedDek: WrappedKey
  nonce: string
  authenticationTag: string
  aadSha256: string
  ciphertext: string
}

export interface CryptoAuditEvent {
  scope: WorkspaceSecurityScope
  action: 'key.rotated' | 'workspace.crypto_erased'
  keyVersion: string | null
}

export type SensitiveRecordType = Extract<
  EncryptionContextV1['recordType'],
  'prompt' | 'model_output' | 'raw_event'
>

export interface SensitiveRecordPort {
  readBatch(input: { afterId: string | null; limit: number }): Promise<
    Array<{
      context: EncryptionContextV1 & { recordType: SensitiveRecordType }
      plaintext: Uint8Array | null
      envelope: EnvelopeV1 | null
    }>
  >
  replacePlaintext(input: {
    context: EncryptionContextV1 & { recordType: SensitiveRecordType }
    expectedPlaintextSha256: string
    envelope: EnvelopeV1
  }): Promise<'updated' | 'already_encrypted' | 'conflict'>
}

export class EncryptionBackfillRunner {
  readonly encryption: EnvelopeEncryption
  readonly port: SensitiveRecordPort
  readonly batchSize: number

  constructor(
    encryption: EnvelopeEncryption,
    port: SensitiveRecordPort,
    batchSize = 100,
  ) {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1_000)
      throw new CryptoError('INVALID_BACKFILL_BATCH_SIZE')
    this.encryption = encryption
    this.port = port
    this.batchSize = batchSize
  }

  async run(): Promise<{
    encrypted: number
    alreadyEncrypted: number
    conflicts: number
  }> {
    let afterId: string | null = null
    let encrypted = 0
    let alreadyEncrypted = 0
    let conflicts = 0
    for (;;) {
      const batch = await this.port.readBatch({
        afterId,
        limit: this.batchSize,
      })
      if (batch.length === 0) break
      for (const record of batch) {
        afterId = record.context.recordId
        if (!record.plaintext) {
          if (record.envelope) alreadyEncrypted++
          continue
        }
        const plaintext = Uint8Array.from(record.plaintext)
        try {
          const envelope = await this.encryption.encrypt(
            record.context,
            plaintext,
          )
          const result = await this.port.replacePlaintext({
            context: record.context,
            expectedPlaintextSha256: createHash('sha256')
              .update(plaintext)
              .digest('hex'),
            envelope,
          })
          if (result === 'updated') encrypted++
          else if (result === 'already_encrypted') alreadyEncrypted++
          else conflicts++
        } finally {
          plaintext.fill(0)
        }
      }
    }
    return { encrypted, alreadyEncrypted, conflicts }
  }
}

export class EnvelopeEncryption {
  readonly kms: KmsProvider
  readonly audit: (event: CryptoAuditEvent) => void
  constructor(
    kms: KmsProvider,
    audit: (event: CryptoAuditEvent) => void = () => {},
  ) {
    this.kms = kms
    this.audit = audit
  }

  async encrypt(
    context: EncryptionContextV1,
    plaintext: Uint8Array,
  ): Promise<EnvelopeV1> {
    const aad = canonicalContext(context)
    const dek = randomBytes(32)
    const nonce = randomBytes(12)
    try {
      const cipher = createCipheriv('aes-256-gcm', dek, nonce)
      cipher.setAAD(aad)
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ])
      const keyVersion = await this.kms.currentKeyVersion(context)
      const encryptedDek = await this.kms.wrapKey(context, dek, keyVersion)
      return {
        formatVersion: ENVELOPE_FORMAT_VERSION,
        algorithm: 'AES-256-GCM',
        keyVersion,
        encryptedDek,
        nonce: nonce.toString('base64'),
        authenticationTag: cipher.getAuthTag().toString('base64'),
        aadSha256: createHash('sha256').update(aad).digest('hex'),
        ciphertext: ciphertext.toString('base64'),
      }
    } finally {
      dek.fill(0)
    }
  }

  async decrypt(
    context: EncryptionContextV1,
    envelope: EnvelopeV1,
  ): Promise<Uint8Array> {
    if (
      envelope.formatVersion !== ENVELOPE_FORMAT_VERSION ||
      envelope.algorithm !== 'AES-256-GCM' ||
      envelope.keyVersion !== envelope.encryptedDek.keyVersion
    )
      throw new CryptoError('ENVELOPE_FORMAT_OR_KEY_SUBSTITUTION')
    const aad = canonicalContext(context)
    const aadHash = createHash('sha256').update(aad).digest('hex')
    if (aadHash !== envelope.aadSha256)
      throw new CryptoError('ENCRYPTION_CONTEXT_MISMATCH')
    const dek = await this.kms.unwrapKey(context, envelope.encryptedDek)
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        dek,
        Buffer.from(envelope.nonce, 'base64'),
      )
      decipher.setAAD(aad)
      decipher.setAuthTag(Buffer.from(envelope.authenticationTag, 'base64'))
      return Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ])
    } catch (error) {
      if (error instanceof CryptoError) throw error
      throw new CryptoError('CIPHERTEXT_AUTHENTICATION_FAILED')
    } finally {
      dek.fill(0)
    }
  }

  async rotate(
    context: EncryptionContextV1,
    envelope: EnvelopeV1,
  ): Promise<EnvelopeV1> {
    const plaintext = await this.decrypt(context, envelope)
    try {
      const rotated = await this.encrypt(context, plaintext)
      this.audit({
        scope: context,
        action: 'key.rotated',
        keyVersion: rotated.keyVersion,
      })
      return rotated
    } finally {
      plaintext.fill(0)
    }
  }

  async cryptoErase(scope: WorkspaceSecurityScope): Promise<void> {
    await this.kms.revokeWorkspace(scope)
    this.audit({
      scope,
      action: 'workspace.crypto_erased',
      keyVersion: null,
    })
  }
}

export interface ChunkedEnvelopeV1 {
  formatVersion: typeof CHUNKED_ENCRYPTION_FORMAT_VERSION
  algorithm: 'AES-256-GCM-CHUNKED'
  chunkBytes: number
  plaintextBytes: number
  encryptedDek: WrappedKey
  keyVersion: string
  chunks: Array<{
    index: number
    nonce: string
    authenticationTag: string
    ciphertext: string
  }>
}

export interface StoredChunkedEnvelopeV1 {
  formatVersion: typeof CHUNKED_ENCRYPTION_FORMAT_VERSION
  algorithm: 'AES-256-GCM-CHUNKED'
  chunkBytes: number
  plaintextBytes: number
  encryptedDek: WrappedKey
  keyVersion: string
  chunks: Array<{
    index: number
    nonce: string
    authenticationTag: string
    ciphertextBytes: number
  }>
}

export interface EncryptedChunkSink {
  write(index: number, ciphertext: Uint8Array): Promise<void>
}

export interface EncryptedChunkSource {
  read(index: number): Promise<Uint8Array>
}

export class ChunkedEnvelopeEncryption {
  readonly kms: KmsProvider
  readonly chunkBytes: number
  constructor(kms: KmsProvider, chunkBytes = 64 * 1024) {
    this.kms = kms
    this.chunkBytes = chunkBytes
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1024)
      throw new CryptoError('INVALID_CHUNK_SIZE')
  }

  async encrypt(
    context: EncryptionContextV1,
    plaintext: Uint8Array,
  ): Promise<ChunkedEnvelopeV1> {
    const dek = randomBytes(32)
    try {
      const keyVersion = await this.kms.currentKeyVersion(context)
      const encryptedDek = await this.kms.wrapKey(context, dek, keyVersion)
      const chunks: ChunkedEnvelopeV1['chunks'] = []
      for (let offset = 0, index = 0; offset < plaintext.byteLength; index++) {
        const source = plaintext.subarray(offset, offset + this.chunkBytes)
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', dek, nonce)
        cipher.setAAD(chunkAad(context, index, plaintext.byteLength))
        const ciphertext = Buffer.concat([
          cipher.update(source),
          cipher.final(),
        ])
        chunks.push({
          index,
          nonce: nonce.toString('base64'),
          authenticationTag: cipher.getAuthTag().toString('base64'),
          ciphertext: ciphertext.toString('base64'),
        })
        offset += source.byteLength
      }
      return {
        formatVersion: CHUNKED_ENCRYPTION_FORMAT_VERSION,
        algorithm: 'AES-256-GCM-CHUNKED',
        chunkBytes: this.chunkBytes,
        plaintextBytes: plaintext.byteLength,
        encryptedDek,
        keyVersion,
        chunks,
      }
    } finally {
      dek.fill(0)
    }
  }

  async encryptToSink(
    context: EncryptionContextV1,
    plaintextBytes: number,
    source: AsyncIterable<Uint8Array>,
    sink: EncryptedChunkSink,
  ): Promise<StoredChunkedEnvelopeV1> {
    if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0)
      throw new CryptoError('INVALID_PLAINTEXT_LENGTH')
    const dek = randomBytes(32)
    let pending = Buffer.alloc(0)
    let consumed = 0
    const chunks: StoredChunkedEnvelopeV1['chunks'] = []
    try {
      const keyVersion = await this.kms.currentKeyVersion(context)
      const encryptedDek = await this.kms.wrapKey(context, dek, keyVersion)
      const writeChunk = async (plaintext: Uint8Array) => {
        const index = chunks.length
        const nonce = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', dek, nonce)
        cipher.setAAD(chunkAad(context, index, plaintextBytes))
        const ciphertext = Buffer.concat([
          cipher.update(plaintext),
          cipher.final(),
        ])
        await sink.write(index, ciphertext)
        chunks.push({
          index,
          nonce: nonce.toString('base64'),
          authenticationTag: cipher.getAuthTag().toString('base64'),
          ciphertextBytes: ciphertext.byteLength,
        })
      }
      for await (const input of source) {
        consumed += input.byteLength
        if (consumed > plaintextBytes)
          throw new CryptoError('PLAINTEXT_LENGTH_OVERFLOW')
        pending = Buffer.concat([pending, input])
        while (pending.byteLength >= this.chunkBytes) {
          await writeChunk(pending.subarray(0, this.chunkBytes))
          pending = pending.subarray(this.chunkBytes)
        }
      }
      if (pending.byteLength > 0) await writeChunk(pending)
      if (consumed !== plaintextBytes)
        throw new CryptoError('PLAINTEXT_LENGTH_MISMATCH')
      return {
        formatVersion: CHUNKED_ENCRYPTION_FORMAT_VERSION,
        algorithm: 'AES-256-GCM-CHUNKED',
        chunkBytes: this.chunkBytes,
        plaintextBytes,
        encryptedDek,
        keyVersion,
        chunks,
      }
    } finally {
      pending.fill(0)
      dek.fill(0)
    }
  }

  async *decryptFromSource(
    context: EncryptionContextV1,
    envelope: StoredChunkedEnvelopeV1,
    source: EncryptedChunkSource,
  ): AsyncGenerator<Uint8Array> {
    if (
      envelope.formatVersion !== CHUNKED_ENCRYPTION_FORMAT_VERSION ||
      envelope.algorithm !== 'AES-256-GCM-CHUNKED' ||
      envelope.keyVersion !== envelope.encryptedDek.keyVersion
    )
      throw new CryptoError('CHUNKED_ENVELOPE_INVALID')
    const dek = await this.kms.unwrapKey(context, envelope.encryptedDek)
    let plaintextBytes = 0
    try {
      for (let index = 0; index < envelope.chunks.length; index++) {
        const metadata = envelope.chunks[index]
        if (!metadata || metadata.index !== index)
          throw new CryptoError('CHUNK_ORDER_INVALID')
        const ciphertext = await source.read(index)
        if (ciphertext.byteLength !== metadata.ciphertextBytes)
          throw new CryptoError('CHUNK_LENGTH_MISMATCH')
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            dek,
            Buffer.from(metadata.nonce, 'base64'),
          )
          decipher.setAAD(chunkAad(context, index, envelope.plaintextBytes))
          decipher.setAuthTag(Buffer.from(metadata.authenticationTag, 'base64'))
          const plaintext = Buffer.concat([
            decipher.update(ciphertext),
            decipher.final(),
          ])
          plaintextBytes += plaintext.byteLength
          yield plaintext
        } catch (error) {
          if (error instanceof CryptoError) throw error
          throw new CryptoError('CHUNK_AUTHENTICATION_FAILED')
        }
      }
      if (plaintextBytes !== envelope.plaintextBytes)
        throw new CryptoError('CHUNK_LENGTH_MISMATCH')
    } finally {
      dek.fill(0)
    }
  }

  async decrypt(
    context: EncryptionContextV1,
    envelope: ChunkedEnvelopeV1,
  ): Promise<Uint8Array> {
    if (
      envelope.formatVersion !== CHUNKED_ENCRYPTION_FORMAT_VERSION ||
      envelope.algorithm !== 'AES-256-GCM-CHUNKED' ||
      envelope.keyVersion !== envelope.encryptedDek.keyVersion
    )
      throw new CryptoError('CHUNKED_ENVELOPE_INVALID')
    const dek = await this.kms.unwrapKey(context, envelope.encryptedDek)
    try {
      const output: Buffer[] = []
      for (let index = 0; index < envelope.chunks.length; index++) {
        const chunk = envelope.chunks[index]
        if (!chunk || chunk.index !== index)
          throw new CryptoError('CHUNK_ORDER_INVALID')
        try {
          const decipher = createDecipheriv(
            'aes-256-gcm',
            dek,
            Buffer.from(chunk.nonce, 'base64'),
          )
          decipher.setAAD(chunkAad(context, index, envelope.plaintextBytes))
          decipher.setAuthTag(Buffer.from(chunk.authenticationTag, 'base64'))
          output.push(
            Buffer.concat([
              decipher.update(Buffer.from(chunk.ciphertext, 'base64')),
              decipher.final(),
            ]),
          )
        } catch (error) {
          if (error instanceof CryptoError) throw error
          throw new CryptoError('CHUNK_AUTHENTICATION_FAILED')
        }
      }
      const plaintext = Buffer.concat(output)
      if (plaintext.byteLength !== envelope.plaintextBytes)
        throw new CryptoError('CHUNK_LENGTH_MISMATCH')
      return plaintext
    } finally {
      dek.fill(0)
    }
  }
}

function chunkAad(
  context: EncryptionContextV1,
  index: number,
  plaintextBytes: number,
): Buffer {
  return Buffer.concat([
    canonicalContext(context),
    Buffer.from(JSON.stringify([index, plaintextBytes])),
  ])
}

export class EncryptedBackupService {
  readonly encryption: ChunkedEnvelopeEncryption
  constructor(encryption: ChunkedEnvelopeEncryption) {
    this.encryption = encryption
  }

  async create(
    scope: WorkspaceSecurityScope,
    backupId: string,
    data: Uint8Array,
  ): Promise<ChunkedEnvelopeV1> {
    return this.encryption.encrypt(
      { ...scope, recordType: 'backup', recordId: backupId },
      data,
    )
  }

  async restore(
    sourceScope: WorkspaceSecurityScope,
    destinationScope: WorkspaceSecurityScope,
    backupId: string,
    envelope: ChunkedEnvelopeV1,
  ): Promise<Uint8Array> {
    if (
      sourceScope.tenantId !== destinationScope.tenantId ||
      sourceScope.organizationId !== destinationScope.organizationId ||
      sourceScope.workspaceId !== destinationScope.workspaceId
    )
      throw new CryptoError('CROSS_TENANT_RESTORE_DENIED')
    return this.encryption.decrypt(
      { ...sourceScope, recordType: 'backup', recordId: backupId },
      envelope,
    )
  }
}

export function writeEncryptedFile(
  path: string,
  envelope: ChunkedEnvelopeV1,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, JSON.stringify(envelope), { flag: 'wx', mode: 0o600 })
}

export function readEncryptedFile(path: string): ChunkedEnvelopeV1 {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new CryptoError('ENCRYPTED_FILE_INVALID')
  return JSON.parse(readFileSync(path, 'utf8')) as ChunkedEnvelopeV1
}

// ---------------------------------------------------------------------------
//  parola-türevli kullanıcı içerik anahtarı (ADR-0037).
// Kullanıcı başına 32 baytlık content key; paroladan Argon2id+HKDF ile türeyen
// user-KEK ve kayıtta bir kez gösterilen recovery key'den HKDF ile türeyen
// recovery-KEK ile ayrı ayrı sarılır. Düz anahtarlar yalnız bellekte yaşar.
// ---------------------------------------------------------------------------

export const USER_CONTENT_KEY_FORMAT_VERSION = 1 as const
export const USER_KEK_HKDF_INFO = 'persistent-codex-user-kek-v1' as const
export const RECOVERY_KEK_HKDF_INFO =
  'persistent-codex-recovery-kek-v1' as const

export interface UserKdfParamsV1 {
  formatVersion: typeof USER_CONTENT_KEY_FORMAT_VERSION
  algorithm: 'argon2id-hkdf-sha256'
  salt: string
  memoryKib: number
  iterations: number
  parallelism: number
  hkdfInfo: string
}

export interface WrappedContentKeyV1 {
  formatVersion: typeof USER_CONTENT_KEY_FORMAT_VERSION
  algorithm: 'AES-256-GCM'
  nonce: string
  authenticationTag: string
  ciphertext: string
}

export interface UserContentKeyScope extends WorkspaceSecurityScope {
  userId: string
  wrapType: 'password' | 'recovery'
}

const DEFAULT_ARGON2ID = {
  memoryKib: 65536,
  iterations: 3,
  parallelism: 1,
} as const

function contentKeyContext(scope: UserContentKeyScope): Buffer {
  return Buffer.from(
    JSON.stringify([
      'user-content-key-context-v1',
      requireScopePart(scope.tenantId, 'tenantId'),
      requireScopePart(scope.organizationId, 'organizationId'),
      requireScopePart(scope.workspaceId, 'workspaceId'),
      requireScopePart(scope.userId, 'userId'),
      scope.wrapType,
    ]),
  )
}

export function createUserKdfParams(hkdfInfo: string): UserKdfParamsV1 {
  return {
    formatVersion: USER_CONTENT_KEY_FORMAT_VERSION,
    algorithm: 'argon2id-hkdf-sha256',
    salt: randomBytes(16).toString('base64'),
    ...DEFAULT_ARGON2ID,
    hkdfInfo,
  }
}

export async function deriveUserKek(
  secret: string,
  params: UserKdfParamsV1,
): Promise<Buffer> {
  if (
    params.formatVersion !== USER_CONTENT_KEY_FORMAT_VERSION ||
    params.algorithm !== 'argon2id-hkdf-sha256'
  )
    throw new CryptoError('UNSUPPORTED_KDF_PARAMS')
  if (secret.length === 0) throw new CryptoError('EMPTY_KDF_SECRET')
  const stretched = await argon2id({
    password: secret,
    salt: Buffer.from(params.salt, 'base64'),
    memorySize: params.memoryKib,
    iterations: params.iterations,
    parallelism: params.parallelism,
    hashLength: 32,
    outputType: 'binary',
  })
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(stretched),
      Buffer.alloc(0),
      params.hkdfInfo,
      32,
    ),
  )
}

export function generateContentKey(): Buffer {
  return randomBytes(32)
}

const RECOVERY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generateRecoveryKey(): string {
  const bytes = randomBytes(20)
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += RECOVERY_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return `RK1-${output.match(/.{1,4}/g)?.join('-') ?? output}`
}

export function normalizeRecoveryKey(recoveryKey: string): string {
  return recoveryKey
    .trim()
    .toUpperCase()
    .replaceAll(/[^0-9A-Z]/g, '')
}

export function recoveryKeySha256(recoveryKey: string): string {
  return createHash('sha256')
    .update(normalizeRecoveryKey(recoveryKey))
    .digest('hex')
}

export function recoveryKeyMatches(
  recoveryKey: string,
  storedSha256Hex: string,
): boolean {
  const candidate = Buffer.from(recoveryKeySha256(recoveryKey), 'hex')
  const stored = Buffer.from(storedSha256Hex, 'hex')
  if (candidate.byteLength !== stored.byteLength) return false
  return timingSafeEqual(candidate, stored)
}

export async function hashUserPassword(password: string): Promise<string> {
  if (password.length < 8) throw new CryptoError('PASSWORD_TOO_SHORT')
  return await argon2id({
    password,
    salt: randomBytes(16),
    memorySize: DEFAULT_ARGON2ID.memoryKib,
    iterations: DEFAULT_ARGON2ID.iterations,
    parallelism: DEFAULT_ARGON2ID.parallelism,
    hashLength: 32,
    outputType: 'encoded',
  })
}

// Bilinmeyen kullanıcı adlarında zamanlama sızıntısını dengelemek için sabit
// bir dummy hash'e karşı doğrulama yapılır (parola: rastgele, erişilemez).
const TIMING_EQUALIZATION_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$q83vASNFZ4mrze8BI0VniQ$' +
  '5eDlyZ0IY0N9E5mLM2GAsuc9uEC7GD4XQGhoJnwwHVE'

export async function verifyUserPassword(
  password: string,
  encodedHash: string | null,
): Promise<boolean> {
  const target = encodedHash ?? TIMING_EQUALIZATION_HASH
  let matches = false
  try {
    matches = await argon2Verify({ password, hash: target })
  } catch {
    matches = false
  }
  return encodedHash === null ? false : matches
}

export function wrapContentKey(
  contentKey: Uint8Array,
  kek: Uint8Array,
  scope: UserContentKeyScope,
): WrappedContentKeyV1 {
  if (contentKey.byteLength !== 32) throw new CryptoError('INVALID_CONTENT_KEY')
  if (kek.byteLength !== 32) throw new CryptoError('INVALID_USER_KEK')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(kek), nonce)
  cipher.setAAD(contentKeyContext(scope))
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(contentKey)),
    cipher.final(),
  ])
  return {
    formatVersion: USER_CONTENT_KEY_FORMAT_VERSION,
    algorithm: 'AES-256-GCM',
    nonce: nonce.toString('base64'),
    authenticationTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }
}

export function unwrapContentKey(
  wrapped: WrappedContentKeyV1,
  kek: Uint8Array,
  scope: UserContentKeyScope,
): Buffer {
  if (
    wrapped.formatVersion !== USER_CONTENT_KEY_FORMAT_VERSION ||
    wrapped.algorithm !== 'AES-256-GCM'
  )
    throw new CryptoError('CONTENT_KEY_FORMAT_INVALID')
  if (kek.byteLength !== 32) throw new CryptoError('INVALID_USER_KEK')
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(kek),
      Buffer.from(wrapped.nonce, 'base64'),
    )
    decipher.setAAD(contentKeyContext(scope))
    decipher.setAuthTag(Buffer.from(wrapped.authenticationTag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(wrapped.ciphertext, 'base64')),
      decipher.final(),
    ])
    if (plaintext.byteLength !== 32)
      throw new CryptoError('INVALID_CONTENT_KEY')
    return plaintext
  } catch (error) {
    if (error instanceof CryptoError) throw error
    throw new CryptoError('CONTENT_KEY_UNWRAP_FAILED')
  }
}

// Kullanıcının çözülmüş content key'ini KEK olarak kullanan KmsProvider.
// EnvelopeEncryption'a değişiklik gerektirmeden mevcut DEK zincirine bağlanır.
export class UserContentKmsProvider implements KmsProvider {
  readonly name = 'user-content-key'
  readonly production = true
  readonly #key: Buffer
  readonly #keyVersion: string

  constructor(contentKey: Uint8Array, keyVersion: string) {
    if (contentKey.byteLength !== 32)
      throw new CryptoError('INVALID_CONTENT_KEY')
    this.#key = Buffer.from(contentKey)
    this.#keyVersion = keyVersion
  }

  async currentKeyVersion(): Promise<string> {
    return this.#keyVersion
  }

  async wrapKey(
    scope: WorkspaceSecurityScope,
    plaintextDek: Uint8Array,
    keyVersion: string,
  ): Promise<WrappedKey> {
    if (keyVersion !== this.#keyVersion)
      throw new CryptoError('KMS_KEY_REVOKED_OR_MISSING')
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce)
    cipher.setAAD(workspaceContext(scope))
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(plaintextDek)),
      cipher.final(),
    ])
    return {
      provider: this.name,
      keyId: 'user-content-key',
      keyVersion,
      ciphertext: Buffer.concat([
        nonce,
        cipher.getAuthTag(),
        ciphertext,
      ]).toString('base64'),
    }
  }

  async unwrapKey(
    scope: WorkspaceSecurityScope,
    wrapped: WrappedKey,
  ): Promise<Uint8Array> {
    if (wrapped.provider !== this.name)
      throw new CryptoError('KMS_KEY_SUBSTITUTION_DENIED')
    // keyVersion burada KEK sargı jenerasyonunu izler (parola/recovery
    // rotasyonunda artar); content key'in kendisi değişmez. Eski jenerasyonla
    // yazılmış zarflar recovery sonrası da açılabilmelidir; bu yüzden sürüm
    // eşitliği dayatılmaz  GCM auth tag'i yanlış anahtarı zaten reddeder.
    const raw = Buffer.from(wrapped.ciphertext, 'base64')
    if (raw.byteLength < 29) throw new CryptoError('WRAPPED_KEY_TOO_SHORT')
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.#key,
        raw.subarray(0, 12),
      )
      decipher.setAAD(workspaceContext(scope))
      decipher.setAuthTag(raw.subarray(12, 28))
      return Buffer.concat([
        decipher.update(raw.subarray(28)),
        decipher.final(),
      ])
    } catch {
      throw new CryptoError('WRAPPED_KEY_AUTHENTICATION_FAILED')
    }
  }

  async revokeWorkspace(): Promise<void> {
    this.#key.fill(0)
  }
}

export interface ContentKeyLeaseAudit {
  scope: WorkspaceSecurityScope
  userId: string
  action: 'secret.lease_issued' | 'secret.lease_revoked'
  leaseId: string
}

export interface ContentKeyLease {
  leaseId: string
  scope: WorkspaceSecurityScope
  userId: string
  keyVersion: string
  expiresAt: number
}

// Login'de çözülen content key'lerin bellek-içi lease yöneticisi. Anahtarlar
// hiçbir zaman diske yazılmaz; expiry veya revoke'ta sıfırlanır.
export class ContentKeyLeaseManager {
  readonly #leases = new Map<string, ContentKeyLease & { contentKey: Buffer }>()
  readonly #ttlMs: number
  readonly #now: () => number
  readonly #audit: (event: ContentKeyLeaseAudit) => void

  constructor(options: {
    ttlMs: number
    now?: () => number
    audit?: (event: ContentKeyLeaseAudit) => void
  }) {
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0)
      throw new CryptoError('INVALID_CONTENT_KEY_LEASE_TTL')
    this.#ttlMs = options.ttlMs
    this.#now = options.now ?? Date.now
    this.#audit = options.audit ?? (() => {})
  }

  issue(input: {
    scope: WorkspaceSecurityScope
    userId: string
    keyVersion: string
    contentKey: Uint8Array
  }): ContentKeyLease {
    if (input.contentKey.byteLength !== 32)
      throw new CryptoError('INVALID_CONTENT_KEY')
    this.revoke(input.scope.workspaceId)
    const lease = {
      leaseId: `ckl_${randomUUID()}`,
      scope: input.scope,
      userId: input.userId,
      keyVersion: input.keyVersion,
      expiresAt: this.#now() + this.#ttlMs,
      contentKey: Buffer.from(input.contentKey),
    }
    this.#leases.set(input.scope.workspaceId, lease)
    this.#audit({
      scope: input.scope,
      userId: input.userId,
      action: 'secret.lease_issued',
      leaseId: lease.leaseId,
    })
    const { contentKey: _contentKey, ...publicLease } = lease
    return publicLease
  }

  acquire(
    workspaceId: string,
  ): (ContentKeyLease & { contentKey: Buffer }) | null {
    const lease = this.#leases.get(workspaceId)
    if (!lease) return null
    if (lease.expiresAt <= this.#now()) {
      this.revoke(workspaceId)
      return null
    }
    lease.expiresAt = this.#now() + this.#ttlMs
    return lease
  }

  revoke(workspaceId: string): boolean {
    const lease = this.#leases.get(workspaceId)
    if (!lease) return false
    lease.contentKey.fill(0)
    this.#leases.delete(workspaceId)
    this.#audit({
      scope: lease.scope,
      userId: lease.userId,
      action: 'secret.lease_revoked',
      leaseId: lease.leaseId,
    })
    return true
  }

  revokeAll(): void {
    for (const workspaceId of [...this.#leases.keys()]) this.revoke(workspaceId)
  }
}
