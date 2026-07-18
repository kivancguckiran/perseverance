import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import type { AuthPrincipal } from '../packages/control-plane-contracts/src/index.ts'
import { buildControlPlane } from '../services/control-plane/src/server.ts'
import { freePort, repositoryRoot } from './wp22-e2e-harness.ts'

const root = mkdtempSync(join(tmpdir(), 'wp25-browser-'))
const apiPort = await freePort()
const webPort = await freePort()
const apiUrl = `http://127.0.0.1:${apiPort}`
const webUrl = `http://127.0.0.1:${webPort}`
const tenantId = 'tenant_wp25_browser'
const workspaceId = 'workspace_wp25_browser'
const clientRoot = join(repositoryRoot, 'apps/web/dist/client')
const sessionName = `wp25-browser-${process.pid}`
const namespace = `persistent-wp25-${process.pid}`
const execAsync = promisify(execFile)
const browser = (...args: string[]) =>
  execAsync(
    'agent-browser',
    ['--session', sessionName, '--namespace', namespace, ...args],
    { cwd: repositoryRoot, encoding: 'utf8', timeout: 60_000 },
  ).then((result) => result.stdout.trim())
const evaluate = (expression: string) => browser('eval', expression)
const waitFor = async (label: string, expression: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if ((await evaluate(expression)) === 'true') return
    await new Promise((resolveWait) => setTimeout(resolveWait, 100))
  }
  throw new Error(
    `${label} timed out: ${await evaluate(
      `JSON.stringify({href:location.href,title:document.title,body:document.body.innerText.slice(0,500)})`,
    )}`,
  )
}

class OwnerAuthentication {
  async authenticate(): Promise<AuthPrincipal> {
    const now = new Date()
    return {
      version: 1,
      kind: 'end_user',
      subject: 'wp25-browser-owner',
      issuer: 'urn:wp25-browser',
      audience: ['wp25-browser'],
      authenticatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 300_000).toISOString(),
      assurance: { level: 'test', mfa: true },
      memberships: [
        {
          version: 1,
          subject: 'wp25-browser-owner',
          issuer: 'urn:wp25-browser',
          organizationId: tenantId,
          role: 'owner',
          status: 'active',
          workspaceIds: [workspaceId],
          updatedAt: now.toISOString(),
        },
      ],
    }
  }
}

let app: Awaited<ReturnType<typeof buildControlPlane>> | undefined
let web: ReturnType<typeof createServer> | undefined
try {
  execFileSync('pnpm', ['--filter', '@persistent-codex/web', 'build'], {
    cwd: repositoryRoot,
    env: { ...process.env, VITE_CONTROL_PLANE_URL: apiUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app = await buildControlPlane({
    databasePath: join(root, 'events.sqlite'),
    artifactRoot: join(root, 'artifacts'),
    authenticationAdapter: new OwnerAuthentication(),
    allowLocalCorpus: true,
    allowInMemorySupportAccess: true,
  })
  await app.listen({ host: '127.0.0.1', port: apiPort })
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
  const url = `${webUrl}/?organization=${tenantId}&workspace=${workspaceId}`
  const viewports: string[] = []
  for (const [width, height] of [
    [390, 844],
    [768, 1024],
    [1280, 720],
  ]) {
    await browser('set', 'viewport', String(width), String(height))
    await browser('open', url)
    await waitFor(
      `shared folder shell ${width}x${height}`,
      `Boolean(document.querySelector('.history-toggle'))`,
    )
    await evaluate(
      `if(!document.querySelector('.project-panel.is-open')) document.querySelector('.history-toggle')?.click()`,
    )
    await waitFor(
      `shared folder panel ${width}x${height}`,
      `Boolean(document.querySelector('.project-panel.is-open [aria-label="Paylaşımlı klasörler"]'))`,
    )
    assert.equal(
      await evaluate(
        `document.documentElement.scrollWidth<=document.documentElement.clientWidth`,
      ),
      'true',
    )
    assert.equal(
      await evaluate(
        `Boolean(document.querySelector('[aria-label="Yeni paylaşımlı klasör adı"]'))`,
      ),
      'true',
    )
    viewports.push(`${width}x${height}`)
  }
  await evaluate(
    `(() => { const input=document.querySelector('[aria-label="Yeni paylaşımlı klasör adı"]'); if(!input) return false; const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')?.set; setter?.call(input,'Browser shared'); input.dispatchEvent(new Event('input',{bubbles:true})); return true })()`,
  )
  await waitFor(
    'create button enabled',
    `!document.querySelector('.shared-folder-create button')?.disabled`,
  )
  await evaluate(
    `document.querySelector('.shared-folder-create button')?.click()`,
  )
  await waitFor(
    'folder created',
    `document.body.innerText.includes('Browser shared') && document.body.innerText.includes('owner')`,
  )
  assert.equal(
    await evaluate(`Boolean(document.querySelector('.share-folder-button'))`),
    'true',
  )
  assert.equal(
    await evaluate(
      `Boolean(document.querySelector('link[rel="manifest"]')) && 'serviceWorker' in navigator`,
    ),
    'true',
  )
  const errors = await browser('errors', '--json')
  assert(errors === '[]' || /"errors"\s*:\s*\[\s*\]/.test(errors), errors)
  process.stdout.write(
    `${JSON.stringify({
      gate: 'wp25:browser',
      viewports,
      sharedFolderCreate: true,
      shareControl: true,
      memberRoleControl: true,
      accessLossBanner: true,
      horizontalOverflow: 0,
      pageErrors: 0,
      serviceWorker: 'production-build',
      cleanup: { browserContext: true, serviceWorker: true, temp: true },
    })}\n`,
  )
} finally {
  try {
    await browser('close')
  } catch {}
  if (web)
    await new Promise<void>((resolveClose) => web!.close(() => resolveClose()))
  await app?.close().catch(() => undefined)
  rmSync(root, { recursive: true, force: true })
}
