import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const issuer = process.env.OIDC_ISSUER
const jwk = JSON.parse(readFileSync('/run/wp30/oidc-public.jwk', 'utf8'))
const send = (response, value) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

createServer((request, response) => {
  if (request.url === '/healthz' || request.url === '/readyz')
    return send(response, { status: 'ready', role: 'external-oidc-stub' })
  if (request.url === '/.well-known/openid-configuration')
    return send(response, {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
    })
  if (request.url === '/jwks') return send(response, { keys: [jwk] })
  response.writeHead(404).end()
}).listen(3303, '0.0.0.0')
