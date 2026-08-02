//  self-hosted iç OIDC issuer'ı (ADR-0032).
// `serve` modu yalnız discovery + JWKS + health sunar; ağ üzerinden token basma
// ucu YOKTUR. Token basımı yalnız `mint` alt komutuyla (docker exec üzerinden,
// private key dosyasını okuyarak) yapılır.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { createPrivateKey, createSign } from 'node:crypto'

const issuer = process.env.OIDC_ISSUER ?? 'http://identity:3303'
const audience = process.env.IDENTITY_AUDIENCE ?? 'persistent-codex-self-hosted'
const publicJwkPath =
  process.env.IDENTITY_PUBLIC_JWK ?? '/run/self-hosted/oidc-public.jwk'
const privateKeyPath =
  process.env.IDENTITY_PRIVATE_KEY ?? '/run/self-hosted/oidc-private.pem'
const keyId = process.env.IDENTITY_KEY_ID ?? 'self-hosted'

const mode = process.argv[2] ?? 'serve'

const base64url = (value) =>
  Buffer.from(value)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')

if (mode === 'mint') {
  // Kullanım: node identity-service.mjs mint <subject> [ttlSeconds]
  const subject = process.argv[3]
  if (!subject) {
    process.stderr.write('usage: identity-service.mjs mint <subject> [ttl]\n')
    process.exit(2)
  }
  const ttl = Math.min(Number(process.argv[4] ?? 4 * 60 * 60), 24 * 60 * 60)
  if (!Number.isFinite(ttl) || ttl <= 0) {
    process.stderr.write('invalid ttl\n')
    process.exit(2)
  }
  const privateKey = createPrivateKey(readFileSync(privateKeyPath, 'utf8'))
  const now = Math.floor(Date.now() / 1000)
  const unsigned = `${base64url(
    JSON.stringify({ alg: 'RS256', kid: keyId, typ: 'at+jwt' }),
  )}.${base64url(
    JSON.stringify({
      iss: issuer,
      aud: audience,
      sub: subject,
      token_use: 'access',
      iat: now,
      auth_time: now,
      exp: now + ttl,
      amr: ['pwd', 'mfa'],
    }),
  )}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey)
  process.stdout.write(`${unsigned}.${base64url(signature)}\n`)
  process.exit(0)
}

if (mode !== 'serve') {
  process.stderr.write(`unknown mode: ${mode}\n`)
  process.exit(2)
}

const jwk = JSON.parse(readFileSync(publicJwkPath, 'utf8'))
const send = (response, value) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

createServer((request, response) => {
  if (request.method !== 'GET') return response.writeHead(405).end()
  if (request.url === '/healthz' || request.url === '/readyz')
    return send(response, { status: 'ready', role: 'self-hosted-identity' })
  if (request.url === '/.well-known/openid-configuration')
    return send(response, {
      issuer,
      jwks_uri: `${issuer}/jwks`,
      id_token_signing_alg_values_supported: ['RS256'],
    })
  if (request.url === '/jwks') return send(response, { keys: [jwk] })
  response.writeHead(404).end()
}).listen(3303, '0.0.0.0')
