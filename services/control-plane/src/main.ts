import { buildControlPlane } from './server'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  runAlphaPreflight,
  type AlphaConfig,
} from '@persistent-codex/workspace-agent'
import {
  createAnthropicCostReconciliationPort,
  createOpenAiCostReconciliationPort,
  priceCatalogSchema,
  providerModelCatalogSchema,
  type ProviderCostReconciliationPort,
  type ProviderId,
} from '@persistent-codex/provider-platform'
import {
  ExplicitDevAuthenticationAdapter,
  OidcAuthenticationAdapter,
} from '@persistent-codex/authz'
import {
  createPostgresSupportAccessRepository,
  InMemorySupportAccessRepository,
} from '@persistent-codex/support-access'
import {
  createPostgresCorpusRepository,
  EncryptedFilesystemCorpusSnapshotStorage,
} from '@persistent-codex/corpus-ingestion'
import {
  ChunkedEnvelopeEncryption,
  EnvelopeEncryption,
  LocalKmsProvider,
} from '@persistent-codex/workspace-security'
import {
  createPostgresPushRepository,
  InMemoryPushRepository,
  PushProviderEmulator,
} from '@persistent-codex/push-notifications'

const port = Number.parseInt(process.env.PORT ?? '3100', 10)
const approvalPolicy = process.env.APPROVAL_POLICY
if (
  approvalPolicy !== undefined &&
  !['untrusted', 'on-request', 'never'].includes(approvalPolicy)
) {
  throw new Error('APPROVAL_POLICY must be untrusted, on-request, or never')
}
const localAlpha = process.env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'
const pushDatabaseUrl = process.env.PUSH_DATABASE_URL
if (!localAlpha && !pushDatabaseUrl)
  throw new Error(
    'Production requires PUSH_DATABASE_URL for durable push delivery',
  )
const pushKms = localAlpha
  ? new LocalKmsProvider(
      createHash('sha256')
        .update(
          process.env.PUSH_LOCAL_KMS_SEED ?? 'persistent-codex-local-push',
        )
        .digest(),
    )
  : undefined
if (!pushKms && pushDatabaseUrl)
  throw new Error(
    'Production push startup requires an injected production-capable KmsProvider',
  )
const pushEncryption = new EnvelopeEncryption(pushKms!)
const pushRepository = pushDatabaseUrl
  ? createPostgresPushRepository({
      connectionString: pushDatabaseUrl,
      encryption: pushEncryption,
    })
  : new InMemoryPushRepository(pushEncryption)
const pushProvider = new PushProviderEmulator()
const supportDatabaseUrl = process.env.SUPPORT_DATABASE_URL
if (!localAlpha && !supportDatabaseUrl)
  throw new Error(
    'Production requires SUPPORT_DATABASE_URL for durable support access governance',
  )
const supportAccessRepository = supportDatabaseUrl
  ? createPostgresSupportAccessRepository({
      connectionString: supportDatabaseUrl,
    })
  : new InMemorySupportAccessRepository({ explicitUsage: 'development' })
const legacyCorpusEncryptionKey = process.env.CORPUS_SNAPSHOT_KEY_BASE64
const localCorpusEncryptionKey =
  process.env.CORPUS_SNAPSHOT_LOCAL_KEY_BASE64 ??
  (localAlpha ? legacyCorpusEncryptionKey : undefined)
const corpusDatabaseUrl = process.env.CORPUS_DATABASE_URL
if (!localAlpha && !corpusDatabaseUrl)
  throw new Error(
    'Production requires CORPUS_DATABASE_URL for the durable corpus repository',
  )
if (!localAlpha && legacyCorpusEncryptionKey)
  throw new Error(
    'CORPUS_SNAPSHOT_KEY_BASE64 is a development-only raw key and is forbidden in production',
  )
if (!localAlpha && corpusDatabaseUrl)
  throw new Error(
    'Production corpus startup requires an injected production-capable KmsProvider; raw snapshot keys are not supported',
  )
const corpusRepository = corpusDatabaseUrl
  ? createPostgresCorpusRepository({ connectionString: corpusDatabaseUrl })
  : undefined
const corpusSnapshotStorage = localCorpusEncryptionKey
  ? new EncryptedFilesystemCorpusSnapshotStorage(
      resolve(process.env.CORPUS_SNAPSHOT_ROOT ?? '.runtime/alpha/corpus'),
      new ChunkedEnvelopeEncryption(
        new LocalKmsProvider(Buffer.from(localCorpusEncryptionKey, 'base64')),
      ),
      { explicitUsage: 'development' },
    )
  : undefined
const runtimeBackend =
  process.env.PERSISTENT_RUNTIME_BACKEND ??
  (localAlpha ? 'local-process' : undefined)
const kmsProvider =
  process.env.PERSISTENT_KMS_PROVIDER ??
  (localAlpha ? 'local-memory' : undefined)
const secretProvider =
  process.env.PERSISTENT_SECRET_PROVIDER ??
  (localAlpha ? 'development-local' : undefined)
if (
  !localAlpha &&
  (runtimeBackend !== 'kata-kubernetes' ||
    kmsProvider !== 'aws-kms' ||
    !secretProvider ||
    secretProvider === 'development-local')
)
  throw new Error(
    'Production requires PERSISTENT_RUNTIME_BACKEND=kata-kubernetes, PERSISTENT_KMS_PROVIDER=aws-kms and a production PERSISTENT_SECRET_PROVIDER',
  )
const authenticationAdapter = localAlpha
  ? new ExplicitDevAuthenticationAdapter()
  : (() => {
      const issuer = process.env.OIDC_ISSUER
      const audience = process.env.OIDC_AUDIENCE
      if (!issuer || !audience)
        throw new Error(
          'OIDC_ISSUER and OIDC_AUDIENCE are required unless PERSISTENT_CODEX_LOCAL_ALPHA=1 explicitly enables dev authentication',
        )
      return new OidcAuthenticationAdapter({ issuer, audience })
    })()
const provisioningSource =
  process.env.CODEX_PROVISIONING_SOURCE ??
  (localAlpha
    ? (process.env.CODEX_HOME ?? join(homedir(), '.codex'))
    : undefined)
const config: AlphaConfig = {
  databasePath: resolve(
    process.env.EVENT_DATABASE_PATH ?? '.runtime/alpha/events.sqlite',
  ),
  workspaceCwd: resolve(process.env.WORKSPACE_CWD ?? process.cwd()),
  codexHomeRoot: resolve(
    process.env.CODEX_HOME_ROOT ?? '.runtime/alpha/codex-homes',
  ),
  artifactRoot: resolve(
    process.env.ARTIFACT_ROOT ?? '.runtime/alpha/artifacts',
  ),
  codexBin: process.env.CODEX_BIN ?? 'codex',
  ...(provisioningSource ? { provisioningSource } : {}),
}
const preflightChecks = runAlphaPreflight(config)
const providerCatalogs = (() => {
  const raw = process.env.PERSISTENT_PROVIDER_CATALOGS_JSON
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed))
    throw new Error('PERSISTENT_PROVIDER_CATALOGS_JSON must be a JSON array')
  return parsed.map((catalog) => providerModelCatalogSchema.parse(catalog))
})()
const priceCatalog = process.env.PERSISTENT_PRICE_CATALOG_JSON
  ? priceCatalogSchema.parse(
      JSON.parse(process.env.PERSISTENT_PRICE_CATALOG_JSON) as unknown,
    )
  : undefined
const costReconciliationPorts = (() => {
  const ports: Partial<Record<ProviderId, ProviderCostReconciliationPort>> = {}
  if (process.env.PERSISTENT_RECONCILIATION_DEDICATED_SCOPE !== '1')
    return ports
  const openAiAdminKey = process.env.OPENAI_ADMIN_KEY
  if (openAiAdminKey) {
    if (
      openAiAdminKey === process.env.OPENAI_API_KEY ||
      openAiAdminKey === process.env.CODEX_API_KEY
    )
      throw new Error(
        'OPENAI_ADMIN_KEY must be separate from the normal inference credential',
      )
    ports.codex = createOpenAiCostReconciliationPort({
      adminApiKey: openAiAdminKey,
      ...(process.env.OPENAI_RECONCILIATION_PROJECT_ID
        ? { projectIds: [process.env.OPENAI_RECONCILIATION_PROJECT_ID] }
        : {}),
      ...(process.env.OPENAI_RECONCILIATION_API_KEY_ID
        ? { apiKeyIds: [process.env.OPENAI_RECONCILIATION_API_KEY_ID] }
        : {}),
    })
  }
  const anthropicAdminKey = process.env.ANTHROPIC_ADMIN_KEY
  if (anthropicAdminKey) {
    if (anthropicAdminKey === process.env.ANTHROPIC_API_KEY)
      throw new Error(
        'ANTHROPIC_ADMIN_KEY must be separate from the normal inference credential',
      )
    ports.claude = createAnthropicCostReconciliationPort({
      adminApiKey: anthropicAdminKey,
      ...(process.env.ANTHROPIC_RECONCILIATION_WORKSPACE_ID
        ? {
            workspaceIds: [process.env.ANTHROPIC_RECONCILIATION_WORKSPACE_ID],
          }
        : {}),
    })
  }
  return ports
})()
const provisioningReady = !preflightChecks.some(
  (check) =>
    check.name === 'provisioning' &&
    check.status === 'failed' &&
    check.code !== 'AUTH_CONFIG_MISSING',
)
const app = await buildControlPlane({
  databasePath: config.databasePath,
  workspaceCwd: config.workspaceCwd,
  codexHomeRoot: config.codexHomeRoot,
  artifactRoot: config.artifactRoot,
  preflightChecks,
  ...(providerCatalogs.length > 0 ? { providerCatalogs } : {}),
  ...(priceCatalog ? { priceCatalog } : {}),
  ...(Object.keys(costReconciliationPorts).length > 0
    ? { costReconciliationPorts }
    : {}),
  ...(process.env.PERSISTENT_CURSOR_FORCE_ALLOWED === '1'
    ? { cursorForceAllowed: true }
    : {}),
  ...(provisioningSource && provisioningReady
    ? {
        codexProvisioningSource: provisioningSource,
      }
    : {}),
  logger: true,
  authenticationAdapter,
  supportAccessRepository,
  pushRepository,
  pushProvider,
  ...(corpusRepository && corpusSnapshotStorage
    ? {
        corpusRepository,
        corpusSnapshotStorage,
        corpusRuntime: {
          endpoint:
            process.env.CORPUS_INTERNAL_ENDPOINT ?? `http://127.0.0.1:${port}`,
        },
      }
    : { allowLocalCorpus: true }),
  securityReadiness: {
    runtimeBackend:
      runtimeBackend === 'kata-kubernetes'
        ? 'kata-kubernetes'
        : 'local-process',
    isolationLevel:
      runtimeBackend === 'kata-kubernetes' ? 'microvm' : 'development_only',
    encryptedVolume: runtimeBackend === 'kata-kubernetes',
    egressDefaultDeny: true,
    secretProvider: secretProvider ?? 'unconfigured',
    secretProviderProduction:
      Boolean(secretProvider) && secretProvider !== 'development-local',
    kmsProvider: kmsProvider ?? 'unconfigured',
    kmsProviderProduction: kmsProvider === 'aws-kms',
    encryptionFormatVersion: 1,
    chunkedEncryptionFormatVersion: 1,
  },
  ...(localAlpha
    ? {
        allowExplicitDevAuthentication: true,
        allowInMemorySupportAccess: true,
      }
    : {}),
  ...(approvalPolicy
    ? {
        approvalPolicy: approvalPolicy as 'untrusted' | 'on-request' | 'never',
      }
    : {}),
})

await app.listen({ host: '127.0.0.1', port })
