import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type {
  AuthenticationAdapter,
  MembershipDirectory,
} from '../packages/authz/src/index'
import type {
  AuthPrincipal,
  OrganizationMembership,
} from '../packages/control-plane-contracts/src/index'
import { SqliteEventStore } from '../packages/event-store/src/index'
import { createPostgresSupportAccessRepository } from '../packages/support-access/src/index'
import { buildControlPlane } from '../services/control-plane/src/server'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientRoot = join(root, 'apps/web/dist/client')
const apiPort = 3217
const webPort = 42_000 + (process.pid % 1_000)
const baseUrl = `http://127.0.0.1:${webPort}`
const apiUrl = `http://127.0.0.1:${apiPort}`
const sessionName = `phase3-security-${process.pid}`
const namespace = `persistent-phase3-${process.pid}`
const temporaryRoot = mkdtempSync(join(tmpdir(), 'persistent-phase3-browser-'))
const execFileAsync = promisify(execFile)
const issuer = 'urn:phase3:browser'
const organizationId = 'org_phase3'
const workspaceId = 'wsp_phase3'
const sessionId = 'ses_phase3'
let currentTime = Date.now()
const postgresName = `persistent-phase3-browser-${randomUUID()}`
const postgresImage = process.env.WP20_POSTGRES_IMAGE ?? 'postgres:17-alpine'
const docker = (...args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8' })
docker(
  'run',
  '--rm',
  '-d',
  '--name',
  postgresName,
  '-e',
  'POSTGRES_PASSWORD=test',
  '-p',
  '127.0.0.1::5432',
  postgresImage,
)
for (let attempt = 0; attempt < 60; attempt++) {
  const logs = spawnSync('docker', ['logs', postgresName], { encoding: 'utf8' })
  if (
    `${logs.stdout}${logs.stderr}`.match(
      /database system is ready to accept connections/g,
    )?.length === 2
  )
    break
  await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  if (attempt === 59) throw new Error('Browser PostgreSQL did not become ready')
}
const migration = (name: string) =>
  readFileSync(join(root, 'infra/postgres/migrations', name), 'utf8')
execFileSync(
  'docker',
  [
    'exec',
    '-i',
    postgresName,
    'psql',
    '-v',
    'ON_ERROR_STOP=1',
    '-U',
    'postgres',
  ],
  {
    input: `${migration('0018_oidc_authorization_rls.sql')}
${migration('0019_runtime_secrets_envelope_encryption.sql')}
${migration('0020_admin_access_governance.sql')}
INSERT INTO persistent_codex.organizations VALUES ('${organizationId}','Browser','active');
INSERT INTO persistent_codex.workspaces VALUES ('${organizationId}','${workspaceId}','Browser');
INSERT INTO persistent_codex.sessions VALUES ('${organizationId}','${workspaceId}','${sessionId}','active');
CREATE ROLE browser_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
GRANT USAGE ON SCHEMA persistent_codex TO browser_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON persistent_codex.support_grants,persistent_codex.support_grant_approvals,persistent_codex.jit_access_leases,persistent_codex.break_glass_requests,persistent_codex.break_glass_approvals,persistent_codex.security_notification_outbox,persistent_codex.access_revocation_epochs TO browser_runtime;
GRANT SELECT ON persistent_codex.immutable_security_audit,persistent_codex.security_audit_chain_heads TO browser_runtime;
GRANT EXECUTE ON FUNCTION persistent_codex.append_security_audit(text,text,text,jsonb,text,text,text,text,text,text) TO browser_runtime;`,
    stdio: ['pipe', 'ignore', 'inherit'],
  },
)
const postgresPort = docker('port', postgresName, '5432/tcp')
  .trim()
  .split(':')
  .at(-1)!
const supportAccessRepository = createPostgresSupportAccessRepository({
  connectionString: `postgresql://browser_runtime:runtime@127.0.0.1:${postgresPort}/postgres`,
  now: () => new Date(currentTime),
})
assert.equal(supportAccessRepository.adapter, 'postgresql')

function opaque(subject: string) {
  return `sha256:${createHash('sha256').update(`${issuer}\0${subject}`).digest('hex')}`
}
const roles: Record<string, OrganizationMembership['role']> = {
  user: 'owner',
  admin: 'admin',
  support: 'support',
  approver: 'security_approver',
}
class BrowserAuthentication implements AuthenticationAdapter {
  async authenticate(request: {
    authorization?: string
  }): Promise<AuthPrincipal> {
    const subject = request.authorization?.replace('Bearer ', '') || 'user'
    if (!roles[subject]) throw new Error('AUTH_REQUIRED')
    return {
      version: 1,
      kind: 'end_user',
      subject,
      issuer,
      audience: ['phase3-browser'],
      authenticatedAt: new Date(currentTime).toISOString(),
      expiresAt: new Date(currentTime + 5 * 60_000).toISOString(),
      assurance: { level: 'strong-mfa', mfa: true },
      memberships: [],
    }
  }
}
const directory: MembershipDirectory = {
  membershipsFor(subject) {
    return [
      {
        version: 1,
        subject,
        issuer,
        organizationId,
        role: roles[subject]!,
        status: 'active',
        workspaceIds: [workspaceId],
        updatedAt: new Date(currentTime).toISOString(),
      },
    ]
  },
}
const scopeHeaders = {
  'content-type': 'application/json',
  'x-tenant-id': organizationId,
  'x-workspace-id': workspaceId,
}
const store = new SqliteEventStore(join(temporaryRoot, 'events.sqlite'))
store.createSession({
  tenantId: organizationId,
  workspaceId,
  sessionId,
  status: 'active',
})
const api = await buildControlPlane({
  eventStore: store,
  artifactRoot: join(temporaryRoot, 'artifacts'),
  attachmentRoot: join(temporaryRoot, 'attachments'),
  codexHomeRoot: join(temporaryRoot, 'codex-homes'),
  workspaceCwd: root,
  authenticationAdapter: new BrowserAuthentication(),
  membershipDirectory: directory,
  supportAccessRepository,
})
const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
}
const serverEntry = (
  await import(pathToFileURL(join(root, 'apps/web/dist/server/server.js')).href)
).default as { fetch(request: Request): Promise<Response> }
const web = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', baseUrl)
    const relative = normalize(decodeURIComponent(url.pathname)).replace(
      /^[/\\]+/,
      '',
    )
    const staticPath = resolve(clientRoot, relative)
    if (
      staticPath.startsWith(`${resolve(clientRoot)}/`) &&
      existsSync(staticPath) &&
      lstatSync(staticPath).isFile()
    ) {
      response.writeHead(200, {
        'content-type':
          contentTypes[extname(staticPath)] ?? 'application/octet-stream',
      })
      createReadStream(staticPath).pipe(response)
      return
    }
    const rendered = await serverEntry.fetch(
      new Request(url, {
        method: request.method,
        headers: request.headers as HeadersInit,
      }),
    )
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  } catch (error) {
    response.writeHead(500)
    response.end(error instanceof Error ? error.message : String(error))
  }
})
async function browser(...args: string[]) {
  const result = await execFileAsync(
    'agent-browser',
    ['--session', sessionName, '--namespace', namespace, ...args],
    { cwd: root, encoding: 'utf8', timeout: 60_000 },
  )
  return result.stdout.trim()
}
const evalBrowser = (expression: string) => browser('eval', expression)
const apiCall = (path: string, subject: string, init: RequestInit = {}) =>
  fetch(`${apiUrl}${path}`, {
    ...init,
    headers: {
      ...scopeHeaders,
      authorization: `Bearer ${subject}`,
      ...(init.headers ?? {}),
    },
  })

try {
  assert(
    existsSync(join(clientRoot, 'sw.js')),
    'Production web build is missing',
  )
  await api.listen({ host: '127.0.0.1', port: apiPort })
  await new Promise<void>((resolveListen, reject) => {
    web.once('error', reject)
    web.listen(webPort, '127.0.0.1', resolveListen)
  })
  const url = `${baseUrl}/sessions/${sessionId}?organization=${organizationId}&workspace=${workspaceId}`
  const sessionResponse = await apiCall(`/v1/sessions/${sessionId}`, 'user')
  assert.equal(sessionResponse.status, 200, await sessionResponse.text())

  await browser('set', 'viewport', '1280', '720')
  await browser('open', url)
  await browser('wait', '1400')
  await evalBrowser(
    `(() => { const text=document.body.innerText; if(!text.includes('Support erişimi')) throw new Error('support settings missing'); if(text.includes('tüm hesaba erişim')) throw new Error('broad account option exposed'); return true })()`,
  )
  await evalBrowser(
    `(() => { const button=[...document.querySelectorAll('button')].find(v=>v.textContent?.includes('Erişim paylaş')); if(!button) throw new Error('share button missing'); button.click(); return true })()`,
  )
  await browser('wait', '200')
  await evalBrowser(`(() => {
    const set=(element,value)=>{ const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'value').set; setter.call(element,value); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})) }
    const form=document.querySelector('.support-access-form'); if(!form) throw new Error('grant modal missing')
    set(form.querySelector('input:not([type=checkbox])'), ${JSON.stringify(opaque('support'))})
    set(form.querySelector('textarea'), 'Kullanıcı tarafından başlatılan dar kapsamlı adversarial tanı')
    const artifact=[...form.querySelectorAll('input[type=checkbox]')][1]; artifact.click()
    form.querySelector('button[type=submit]').click(); return true
  })()`)
  await browser('wait', '700')
  let grant = (
    await supportAccessRepository.transaction(
      { tenantId: organizationId, organizationId, workspaceId },
      (service) => service.listGrants({ organizationId, workspaceId }),
    )
  )[0]!
  assert.equal(grant.status, 'pending_approval')
  assert.deepEqual(grant.actions, ['content.view', 'artifact.download'])

  const adminDenied = await apiCall(`/v1/sessions/${sessionId}/events`, 'admin')
  assert.equal(
    adminDenied.status,
    403,
    'admin read without grant was not denied',
  )
  for (const [subject, key] of [
    ['support', 'one'],
    ['approver', 'two'],
  ] as const) {
    const response = await apiCall(
      `/v1/support-grants/${grant.grantId}/decision`,
      subject,
      {
        method: 'POST',
        headers: { 'idempotency-key': `approval-${key}` },
        body: JSON.stringify({
          decision: 'approve',
          expectedVersion: grant.version,
          mfaEvidenceId: `mfa-${key}`,
        }),
      },
    )
    assert.equal(response.status, 200, await response.text())
    grant = (
      await supportAccessRepository.transaction(
        { tenantId: organizationId, organizationId, workspaceId },
        (service) => service.listGrants({ organizationId, workspaceId }),
      )
    )[0]!
  }
  assert.equal(grant.status, 'active')
  const leaseResponse = await apiCall('/v1/support-access/leases', 'support', {
    method: 'POST',
    headers: { 'idempotency-key': 'browser-view-lease' },
    body: JSON.stringify({
      schemaVersion: 1,
      grantId: grant.grantId,
      sessionId,
      objectId: null,
      action: 'content.view',
    }),
  })
  assert.equal(leaseResponse.status, 200, await leaseResponse.clone().text())
  const lease = await leaseResponse.json()
  const wrongScope = await apiCall(
    `/v1/support-access/leases/${lease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        token: lease.token,
        sessionId: 'wrong',
        objectId: null,
        action: 'content.view',
      }),
    },
  )
  assert.equal(wrongScope.status, 403)
  const protectedView = await apiCall(
    `/v1/support-access/leases/${lease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        token: lease.token,
        sessionId,
        objectId: null,
        action: 'content.view',
      }),
    },
  )
  assert.equal(protectedView.status, 200, await protectedView.clone().text())
  assert.equal((await protectedView.json()).action, 'content.view')
  const replay = await apiCall(
    `/v1/support-access/leases/${lease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        token: lease.token,
        sessionId,
        objectId: null,
        action: 'content.view',
      }),
    },
  )
  assert.equal(replay.status, 403)
  const revokeLeaseResponse = await apiCall(
    '/v1/support-access/leases',
    'support',
    {
      method: 'POST',
      headers: { 'idempotency-key': 'browser-revoke-lease' },
      body: JSON.stringify({
        schemaVersion: 1,
        grantId: grant.grantId,
        sessionId,
        objectId: null,
        action: 'content.view',
      }),
    },
  )
  assert.equal(revokeLeaseResponse.status, 200)
  const revokeLease = await revokeLeaseResponse.json()

  await browser('reload')
  await browser('wait', '700')
  await evalBrowser(
    `(() => { const button=[...document.querySelectorAll('button')].find(v=>v.textContent?.includes('Erken iptal et')); if(!button) throw new Error('revoke button missing'); button.click(); return true })()`,
  )
  await browser('wait', '700')
  assert.equal(
    (
      await supportAccessRepository.transaction(
        { tenantId: organizationId, organizationId, workspaceId },
        (service) => service.listGrants({ organizationId, workspaceId }),
      )
    )[0]!.status,
    'revoked',
  )
  const revokedLease = await apiCall(
    `/v1/support-access/leases/${revokeLease.lease.leaseId}/consume`,
    'support',
    {
      method: 'POST',
      body: JSON.stringify({
        schemaVersion: 1,
        token: revokeLease.token,
        sessionId,
        objectId: null,
        action: 'content.view',
      }),
    },
  )
  assert.equal(revokedLease.status, 403)

  await browser('reload')
  await browser('wait', '700')
  await evalBrowser(
    `(() => { const text=document.body.innerText; if(!text.includes('Erken iptal edildi')) throw new Error('revoked state missing'); if(!text.includes('zincir doğrulandı')) throw new Error('audit integrity missing'); if(text.includes('plaintext-secret')) throw new Error('secret leaked'); if(document.documentElement.scrollWidth>document.documentElement.clientWidth) throw new Error('desktop overflow'); return true })()`,
  )
  await browser('set', 'viewport', '390', '844')
  await browser('wait', '300')
  await evalBrowser(
    `(() => { if(document.documentElement.scrollWidth>document.documentElement.clientWidth) throw new Error('mobile overflow'); if(!document.body.innerText.includes('Support erişimi')) throw new Error('mobile support context missing'); return true })()`,
  )
  const errors = await browser('errors', '--json')
  assert(
    errors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errors),
    `Browser page errors: ${errors}`,
  )
  assert(
    await supportAccessRepository.verifyAuditChain({
      tenantId: organizationId,
      organizationId,
      workspaceId,
    }),
  )
  console.log(
    JSON.stringify({
      browser: 'passed',
      supportRepository: supportAccessRepository.adapter,
      viewports: ['1280x720', '390x844'],
      grantFlow: 'user-create+mfa+double-approval+scope-deny+revoke-generation',
      adminWithoutGrant: 'denied',
      audit: 'visible+hash-chain-valid',
      pageErrors: 0,
      secretLeaks: 0,
    }),
  )
} finally {
  try {
    await browser('close')
  } catch {}
  await api.close()
  await new Promise<void>((resolveClose) => web.close(() => resolveClose()))
  store.close()
  try {
    docker('rm', '-f', postgresName)
  } catch {}
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })
}
