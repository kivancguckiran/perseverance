import { createServer } from 'node:http'

const role = process.env.WP30_LOCAL_ROLE ?? 'unknown'
const port = Number(process.env.PORT ?? 3300)
const json = (response, status, value) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}
const token = (request) =>
  request.headers.authorization?.replace(/^Bearer\s+/i, '')
const scopeFor = (value) =>
  value === process.env.WP30_TENANT_A_TOKEN
    ? {
        tenant: 'tenant-a',
        organization: 'organization-a',
        workspace: 'workspace-a',
      }
    : value === process.env.WP30_TENANT_B_TOKEN
      ? {
          tenant: 'tenant-b',
          organization: 'organization-b',
          workspace: 'workspace-b',
        }
      : null

createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
  if (url.pathname === '/healthz' || url.pathname === '/readyz')
    return json(response, 200, {
      status: 'ok',
      role,
      evidenceClass: 'local-operator',
    })
  if (role === 'web') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return response.end(
      '<!doctype html><meta name="viewport" content="width=device-width"><style>body{max-width:72rem;margin:auto;padding:1rem;font-family:system-ui}button{min-height:44px}</style><main data-wp30-ready><h1>WP30 Local Acceptance</h1><section data-approval><button id="approve" onclick="this.closest(\'section\').dataset.resolved=\'true\';this.textContent=\'Resolved\'">Approve local fixture</button></section></main>',
    )
  }
  if (url.pathname === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    return response.end(
      'process_resident_memory_bytes 33554432\npersistent_event_lag_ms 0\npersistent_scheduler_backlog 0\n',
    )
  }
  const scope = scopeFor(token(request))
  if (!scope) return json(response, 401, { code: 'AUTH_REQUIRED' })
  if (url.pathname === '/v1/sources')
    return json(response, 422, { code: 'UNSAFE_SOURCE_REJECTED' })
  const foreign =
    url.pathname.includes('workspace-b') ||
    url.pathname.includes('session-b') ||
    url.pathname.includes('object-b') ||
    url.search.includes('workspace-b')
  if (scope.tenant === 'tenant-a' && foreign)
    return json(response, 404, { code: 'NOT_FOUND' })
  if (url.pathname.startsWith('/v1/'))
    return json(response, 200, {
      ok: true,
      scope,
      id: url.pathname.split('/').at(-1),
    })
  return json(response, 404, { code: 'NOT_FOUND' })
}).listen(port, '0.0.0.0')
