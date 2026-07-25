import type {
  ObservedRuntime,
  TenantResourceScope,
  TenantRuntimeResources,
} from '@persistent-codex/tenant-runtime'
import type { CapacityVector } from '@persistent-codex/production-topology/contracts'
import type { AwsKmsClientPort } from '@persistent-codex/workspace-security'

async function jsonRequest<T>(
  baseUrl: string,
  token: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`MANAGED_INFRA_${response.status}`)
  return (await response.json()) as T
}

export class HttpTenantRuntimeResources implements TenantRuntimeResources {
  readonly #url: string
  readonly #token: string
  constructor(url: string, token: string) {
    this.#url = url
    this.#token = token
  }
  #post<T>(operation: string, input: unknown) {
    return jsonRequest<T>(
      this.#url,
      this.#token,
      `/v1/tenant-runtime/resources/${operation}`,
      input,
    )
  }
  ensureRuntimeIdentity(input: TenantResourceScope) {
    return this.#post<{ identitySubject: string }>('identity/ensure', input)
  }
  ensureEncryptionKey(input: TenantResourceScope) {
    return this.#post<{
      kmsProvider: string
      kmsKeyId: string
      kmsKeyVersion: number
    }>('encryption-key/ensure', input)
  }
  async cryptoEraseKey(input: TenantResourceScope) {
    await this.#post('encryption-key/erase', input)
  }
  ensureVolume(input: TenantResourceScope) {
    return this.#post<{ volumeId: string; encrypted: boolean }>(
      'volume/ensure',
      input,
    )
  }
  async releaseVolume(input: TenantResourceScope) {
    await this.#post('volume/release', input)
  }
  ensureSecretNamespace(input: TenantResourceScope) {
    return this.#post<{ secretNamespace: string }>(
      'secret-namespace/ensure',
      input,
    )
  }
  async purgeSecretNamespace(input: TenantResourceScope) {
    await this.#post('secret-namespace/purge', input)
  }
  ensureNetworkPolicy(input: TenantResourceScope) {
    return this.#post<{ networkPolicyId: string; defaultDeny: boolean }>(
      'network-policy/ensure',
      input,
    )
  }
  async removeNetworkPolicy(input: TenantResourceScope) {
    await this.#post('network-policy/remove', input)
  }
  ensurePlacement(
    input: TenantResourceScope & {
      regionId: string
      capacity: CapacityVector
    },
  ) {
    return this.#post<{ nodeId: string }>('placement/ensure', input)
  }
  async releasePlacement(input: TenantResourceScope) {
    await this.#post('placement/release', input)
  }
  reserveCapacity(input: TenantResourceScope & { capacity: CapacityVector }) {
    return this.#post<{ capacityReservationId: string }>(
      'capacity/reserve',
      input,
    )
  }
  async releaseCapacity(input: TenantResourceScope) {
    await this.#post('capacity/release', input)
  }
  async startRuntime(
    input: TenantResourceScope & {
      generation: number
    },
  ) {
    await this.#post('runtime/start', input)
  }
  async drainRuntime(input: TenantResourceScope) {
    await this.#post('runtime/drain', input)
  }
  async destroyRuntime(observedRuntimeId: string) {
    await this.#post('runtime/destroy', { observedRuntimeId })
  }
  listObservedRuntimes() {
    return jsonRequest<ObservedRuntime[]>(
      this.#url,
      this.#token,
      '/v1/tenant-runtime/resources/observed',
    )
  }
}

export class HttpAwsKmsClient implements AwsKmsClientPort {
  readonly #url: string
  readonly #token: string
  constructor(url: string, token: string) {
    this.#url = url
    this.#token = token
  }
  async encrypt(input: {
    keyId: string
    keyVersion: string
    plaintext: Uint8Array
    encryptionContext: Record<string, string>
  }) {
    const result = await jsonRequest<{ ciphertext: string }>(
      this.#url,
      this.#token,
      '/v1/kms/encrypt',
      { ...input, plaintext: Buffer.from(input.plaintext).toString('base64') },
    )
    return Buffer.from(result.ciphertext, 'base64')
  }
  async decrypt(input: {
    ciphertext: Uint8Array
    encryptionContext: Record<string, string>
    keyId: string
  }) {
    const result = await jsonRequest<{ plaintext: string }>(
      this.#url,
      this.#token,
      '/v1/kms/decrypt',
      {
        ...input,
        ciphertext: Buffer.from(input.ciphertext).toString('base64'),
      },
    )
    return Buffer.from(result.plaintext, 'base64')
  }
  async scheduleWorkspaceErasure(
    scope: Parameters<AwsKmsClientPort['scheduleWorkspaceErasure']>[0],
  ) {
    await jsonRequest(this.#url, this.#token, '/v1/kms/workspaces/erase', scope)
  }
}
