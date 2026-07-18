import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type {
  AuthPrincipal,
  OrganizationMembership,
} from '../packages/control-plane-contracts/src/index.ts'
import type {
  AuthenticationAdapter,
  MembershipDirectory,
} from '../packages/authz/src/index.ts'
import { AuthenticationError } from '../packages/authz/src/index.ts'
import { createPostgresSharedFolderRepository } from '../packages/shared-folders/src/postgres.ts'
import { buildControlPlane } from '../services/control-plane/src/server.ts'
import { freePort, repositoryRoot, Wp22E2eHarness } from './wp22-e2e-harness.ts'

const codexBin = process.env.WP25_CODEX_BIN
if (!codexBin) throw new Error('WP25_CODEX_BIN is required')
const codexVersion = execFileSync(codexBin, ['--version'], {
  encoding: 'utf8',
}).trim()
if (!codexVersion.includes('0.144.2'))
  throw new Error(`WP25_CODEX_VERSION_MISMATCH: ${codexVersion}`)
process.env.CODEX_BIN = codexBin

const tenantId = 'tenant_wp25_browser'
const workspaceId = 'workspace_wp25_browser'
const issuer = 'urn:wp25-browser'
const subjects = {
  owner: 'principal_wp25_browser_owner',
  friend: 'principal_wp25_browser_friend',
} as const
const opaque = (subject: string) =>
  `sha256:${createHash('sha256').update(`${issuer}\u0000${subject}`).digest('hex')}`

class BrowserAuthentication implements AuthenticationAdapter {
  async authenticate(input: {
    authorization?: string
  }): Promise<AuthPrincipal> {
    const key = input.authorization?.match(/^Bearer (owner|friend)$/)?.[1] as
      keyof typeof subjects | undefined
    if (!key) throw new AuthenticationError('AUTH_REQUIRED')
    const now = new Date()
    return {
      version: 1,
      kind: 'end_user',
      subject: subjects[key],
      issuer,
      audience: ['persistent-codex'],
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      assurance: { level: 'mfa', mfa: true },
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
        organizationId: tenantId,
        role: 'developer',
        status: 'active',
        workspaceIds: [workspaceId],
        updatedAt: new Date(0).toISOString(),
      } satisfies OrganizationMembership,
    ]
  },
}
const apiHeaders = (principal: 'owner' | 'friend') => ({
  authorization: `Bearer ${principal}`,
  'x-tenant-id': tenantId,
  'x-workspace-id': workspaceId,
})

const harness = new Wp22E2eHarness({ tenantId, workspaceId, phase4: true })
const apiPort = await freePort()
const webPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const namespace = `w25-${process.pid}`
const execAsync = promisify(execFile)
const browser = (session: 'owner' | 'friend', ...args: string[]) =>
  execAsync(
    'agent-browser',
    [
      '--session',
      `${session[0]}-${process.pid}`,
      '--namespace',
      namespace,
      ...args,
    ],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 },
  ).then((result) => result.stdout.trim())
const evaluate = (session: 'owner' | 'friend', expression: string) =>
  browser(session, 'eval', expression)
const waitFor = async (
  session: 'owner' | 'friend',
  label: string,
  expression: string,
  timeout = 30_000,
) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await evaluate(session, expression)) === 'true') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(
    `${label} timed out: ${await evaluate(session, 'document.body.innerText.slice(0,800)')}`,
  )
}
const authenticate = async (session: 'owner' | 'friend', url: string) => {
  await browser(session, 'open', `${apiUrl}/healthz`)
  await browser(
    session,
    'set',
    'headers',
    JSON.stringify({ Authorization: `Bearer ${session}` }),
  )
  await browser(session, 'open', url)
  await evaluate(
    session,
    `sessionStorage.setItem('persistent.auth',${JSON.stringify(JSON.stringify({ accessToken: session }))});true`,
  )
  await waitFor(
    session,
    `${session} authenticated shell`,
    `Boolean(document.querySelector('.history-toggle'))`,
  )
  await evaluate(
    session,
    `if(!document.querySelector('.project-panel.is-open')) document.querySelector('.history-toggle')?.click();true`,
  )
  await waitFor(
    session,
    `${session} shared folder panel`,
    `Boolean(document.querySelector('.project-panel.is-open [aria-label="Paylaşımlı klasörler"]'))`,
  )
}

let app: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let web: ReturnType<typeof createServer> | undefined
let evidence: Record<string, unknown> | undefined
try {
  await harness.start()
  mkdirSync(join(harness.root, 'workspace'))
  app = await buildControlPlane({
    databasePath: join(harness.root, 'events.sqlite'),
    artifactRoot: join(harness.root, 'artifacts'),
    workspaceCwd: join(harness.root, 'workspace'),
    codexHomeRoot: join(harness.root, 'codex-homes'),
    codexProvisioningSource:
      process.env.CODEX_PROVISIONING_SOURCE ??
      process.env.CODEX_HOME ??
      join(homedir(), '.codex'),
    authenticationAdapter: new BrowserAuthentication(),
    membershipDirectory: directory,
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
    sharedFolderRepository: createPostgresSharedFolderRepository(
      harness.connectionString,
    ),
  })
  await app.listen({ host: '127.0.0.1', port: apiPort })
  execFileSync('pnpm', ['--filter', '@persistent-codex/web', 'build'], {
    cwd: repositoryRoot,
    env: { ...process.env, VITE_CONTROL_PLANE_URL: apiUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const clientRoot = join(repositoryRoot, 'apps/web/dist/client')
  const contentTypes: Record<string, string> = {
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
  }
  const serverEntry = (
    await import(
      pathToFileURL(join(repositoryRoot, 'apps/web/dist/server/server.js')).href
    )
  ).default as { fetch(request: Request): Promise<Response> }
  web = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', webUrl)
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
    const rendered = await serverEntry.fetch(new Request(url))
    response.writeHead(rendered.status, Object.fromEntries(rendered.headers))
    response.end(Buffer.from(await rendered.arrayBuffer()))
  })
  await new Promise<void>((resolveListen, reject) => {
    web!.once('error', reject)
    web!.listen(webPort, '127.0.0.1', resolveListen)
  })
  const base = `${webUrl}/?organization=${tenantId}&workspace=${workspaceId}`
  await authenticate('owner', base)

  const viewports: string[] = []
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1280, 720],
  ]) {
    await browser('owner', 'set', 'viewport', String(width), String(height))
    await browser('owner', 'open', base)
    await waitFor(
      'owner',
      `${width}x${height} shell`,
      `Boolean(document.querySelector('.history-toggle'))`,
    )
    await evaluate(
      'owner',
      `if(!document.querySelector('.project-panel.is-open')) document.querySelector('.history-toggle')?.click();true`,
    )
    await waitFor(
      'owner',
      `${width}x${height} shared panel`,
      `Boolean(document.querySelector('.project-panel.is-open [aria-label="Paylaşımlı klasörler"]'))`,
    )
    assert.equal(
      await evaluate(
        'owner',
        `document.documentElement.scrollWidth<=document.documentElement.clientWidth`,
      ),
      'true',
    )
    viewports.push(`${width}x${height}`)
  }

  const createFolder = async (name: string) => {
    await evaluate(
      'owner',
      `(() => { const i=document.querySelector('[aria-label="Yeni paylaşımlı klasör adı"]'); const s=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set; s?.call(i,${JSON.stringify(name)}); i?.dispatchEvent(new Event('input',{bubbles:true})); return true })()`,
    )
    await waitFor(
      'owner',
      `${name} create enabled`,
      `!document.querySelector('.shared-folder-create button')?.disabled`,
    )
    await evaluate(
      'owner',
      `document.querySelector('.shared-folder-create button')?.click();true`,
    )
    await waitFor(
      'owner',
      `${name} created`,
      `document.body.innerText.includes(${JSON.stringify(name)})`,
    )
  }
  await createFolder('Browser shared')
  await createFolder('Browser private')
  await evaluate(
    'owner',
    `Array.from(document.querySelectorAll('.shared-folder-list li')).find(li=>li.textContent?.includes('Browser shared'))?.querySelector('button')?.click();true`,
  )
  await evaluate(
    'owner',
    `Array.from(document.querySelectorAll('.shared-folder-list li')).find(li=>li.textContent?.includes('Browser shared'))?.querySelector('.share-folder-button')?.click();true`,
  )
  await waitFor(
    'owner',
    'invite token visible',
    `Boolean(document.querySelector('.invite-token code')?.textContent)`,
  )
  const token = (
    await evaluate(
      'owner',
      `document.querySelector('.invite-token code')?.textContent ?? ''`,
    )
  ).replace(/^"|"$/g, '')
  assert(token.length >= 40)

  const inviteUrl = `${base}&invite=${encodeURIComponent(token)}`
  await authenticate('friend', inviteUrl)
  await waitFor(
    'friend',
    'invite banner',
    `document.body.innerText.includes('Daveti kabul et')`,
  )
  await evaluate(
    'friend',
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent?.includes('Daveti kabul et'))?.click();true`,
  )
  await waitFor(
    'friend',
    'friend viewer folder',
    `document.body.innerText.includes('Browser shared') && document.body.innerText.includes('viewer')`,
  )
  assert.equal(
    await evaluate(
      'friend',
      `document.body.innerText.includes('Browser private')`,
    ),
    'false',
  )

  await browser('owner', 'open', base)
  await waitFor(
    'owner',
    'owner refreshed shell',
    `Boolean(document.querySelector('.history-toggle'))`,
  )
  await evaluate(
    'owner',
    `if(!document.querySelector('.project-panel.is-open')) document.querySelector('.history-toggle')?.click();true`,
  )
  await waitFor(
    'owner',
    'owner refreshed panel',
    `Boolean(document.querySelector('.shared-folder-list'))`,
  )
  await evaluate(
    'owner',
    `Array.from(document.querySelectorAll('.shared-folder-list li')).find(li=>li.textContent?.includes('Browser shared'))?.querySelector('button')?.click();true`,
  )
  await waitFor(
    'owner',
    'friend membership',
    `Array.from(document.querySelectorAll('.shared-member-list select')).some(s=>s.value==='viewer')`,
  )
  await evaluate(
    'owner',
    `(() => { const s=Array.from(document.querySelectorAll('.shared-member-list select')).find(s=>s.value==='viewer'); const set=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value')?.set; set?.call(s,'editor'); s?.dispatchEvent(new Event('change',{bubbles:true})); return true })()`,
  )
  await waitFor(
    'owner',
    'friend editor role',
    `Array.from(document.querySelectorAll('.shared-member-list select')).some(s=>s.value==='editor')`,
  )

  const folders = await app.inject({
    method: 'GET',
    url: '/v1/folders',
    headers: apiHeaders('owner'),
  })
  const sharedFolder = folders
    .json()
    .folders.find(
      (entry: { folder: { name: string } }) =>
        entry.folder.name === 'Browser shared',
    )
  const session = await app.inject({
    method: 'POST',
    url: '/v1/sessions',
    headers: { ...apiHeaders('owner'), 'content-type': 'application/json' },
    payload: { folderId: sharedFolder.folder.folderId },
  })
  assert.equal(session.statusCode, 201, session.body)
  const sessionId = session.json().sessionId as string
  const friendSessionUrl = `${webUrl}/sessions/${sessionId}?organization=${tenantId}&workspace=${workspaceId}`
  await browser('friend', 'open', friendSessionUrl)
  await waitFor(
    'friend',
    'friend realtime session',
    `Array.from(document.querySelectorAll('dt')).find(node=>node.textContent==='Realtime')?.nextElementSibling?.textContent==='canlı'`,
  )

  const startExpression = `(async()=>{const r=await fetch(${JSON.stringify(`${apiUrl}/v1/sessions/${sessionId}/turns`)},{method:'POST',headers:{'content-type':'application/json','x-tenant-id':${JSON.stringify(tenantId)},'x-workspace-id':${JSON.stringify(workspaceId)},'idempotency-key':'wp25-browser-shared-turn'},body:JSON.stringify({prompt:'Run curl -I https://example.com and request approval.'})});return JSON.stringify({status:r.status,body:await r.json()})})()`
  const browserTurnResults = await Promise.all([
    evaluate('owner', startExpression),
    evaluate('friend', startExpression),
  ])
  for (const result of browserTurnResults)
    assert(result.includes('202'), result)
  let browserApproval: { approvalId: string; version: number } | undefined
  for (let attempt = 0; attempt < 200 && !browserApproval; attempt++) {
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers: apiHeaders('owner'),
    })
    browserApproval = pending.json().approvals?.[0]
    if (!browserApproval)
      await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert(browserApproval)
  const decisionExpression = (device: string) =>
    `(async()=>{const r=await fetch(${JSON.stringify(`${apiUrl}/v1/approvals/${browserApproval!.approvalId}/decision`)},{method:'POST',headers:{'content-type':'application/json','x-tenant-id':${JSON.stringify(tenantId)},'x-workspace-id':${JSON.stringify(workspaceId)},'idempotency-key':${JSON.stringify(`wp25-browser-${device}`)}},body:JSON.stringify({decision:'accept',expectedVersion:${browserApproval.version},clientContext:{deviceId:${JSON.stringify(device)},reason:null}})});return String(r.status)})()`
  const browserApprovalStatuses = await Promise.all([
    evaluate('owner', decisionExpression('owner')),
    evaluate('friend', decisionExpression('friend')),
  ])
  assert.equal(
    browserApprovalStatuses.filter((value) => value.includes('200')).length,
    1,
  )
  assert.equal(
    browserApprovalStatuses.filter((value) => value.includes('409')).length,
    1,
  )

  await evaluate(
    'owner',
    `(() => { const li=Array.from(document.querySelectorAll('.shared-member-list li')).find(li=>li.querySelector('select')?.value==='editor'); li?.querySelector('button')?.click(); return true })()`,
  )
  await waitFor(
    'friend',
    'realtime access loss',
    `document.body.innerText.includes('Bu klasöre erişimin kaldırıldı')`,
    30_000,
  )
  assert.equal(
    await evaluate(
      'friend',
      `document.body.innerText.includes('Browser private')`,
    ),
    'false',
  )

  const ownerErrors = await browser('owner', 'errors', '--json')
  const friendErrors = await browser('friend', 'errors', '--json')
  assert(
    ownerErrors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(ownerErrors),
    ownerErrors,
  )
  assert(
    friendErrors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(friendErrors),
    friendErrors,
  )
  evidence = {
    gate: 'wp25:browser',
    codexVersion,
    principals: [opaque(subjects.owner), opaque(subjects.friend)],
    folderId: sharedFolder.folder.folderId,
    sessionId,
    taskContexts: ['owner', 'friend'],
    approvalRace: browserApprovalStatuses,
    viewports,
    inviteAcceptedRole: 'viewer',
    promotedRole: 'editor',
    realtimeRevokeBanner: 'asserted',
    privateFolderVisibleToFriend: false,
    horizontalOverflow: 0,
    pageErrors: 0,
    contexts: ['owner', 'friend'],
  }
} finally {
  await Promise.all([
    browser('owner', 'close').catch(() => undefined),
    browser('friend', 'close').catch(() => undefined),
  ])
  if (web)
    await new Promise<void>((resolveClose) => web!.close(() => resolveClose()))
  await app?.close().catch(() => undefined)
  await harness.cleanup()
}
if (evidence)
  process.stdout.write(
    `${JSON.stringify({ ...evidence, cleanup: { browserContexts: true, serviceWorker: true, postgres: true, temp: true } })}\n`,
  )
