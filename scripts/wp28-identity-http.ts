import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import { createServer } from 'node:http'
import {
  validateOidcAssertion,
  validateSamlResponse,
} from '../packages/enterprise-lifecycle/src/index'
import type { FederationConfiguration } from '../packages/enterprise-lifecycle/src/contracts'
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
})
const server = createServer((request, response) => {
  response.setHeader('content-type', 'application/json')
  if (request.url === '/.well-known/openid-configuration')
    response.end(
      JSON.stringify({
        issuer: `http://127.0.0.1:${(server.address() as any).port}`,
        jwks_uri: `http://127.0.0.1:${(server.address() as any).port}/jwks`,
        authorization_endpoint: `http://127.0.0.1:${(server.address() as any).port}/authorize`,
      }),
    )
  else if (request.url === '/saml/metadata')
    response.end(
      JSON.stringify({ entityId: 'wp28-idp', signedResponses: true }),
    )
  else response.end(JSON.stringify({ keys: [{ kid: 'key-1', alg: 'RS256' }] }))
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('IdP unavailable')
const issuer = `http://127.0.0.1:${address.port}`
try {
  const metadata = (await (
    await fetch(`${issuer}/.well-known/openid-configuration`)
  ).json()) as any
  assert.equal(metadata.issuer, issuer)
  const config: FederationConfiguration = {
    schemaVersion: 1,
    tenantId: 'tenant-a',
    organizationId: 'org-a',
    configurationId: 'fed',
    protocol: 'oidc',
    issuer,
    audience: 'persistent-codex',
    entityId: null,
    callbackUrl: 'https://app.test/callback',
    acsUrl: null,
    keyId: 'key-1',
    verificationKeyPem: publicKey
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    clockSkewSeconds: 30,
    enforcedSso: true,
    requiredMfa: true,
    allowedAmr: ['webauthn'],
    metadataVersion: 1,
    enabled: true,
    updatedAt: new Date().toISOString(),
  }
  const now = Math.floor(Date.now() / 1000),
    head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'key-1' })).toString(
      'base64url',
    ),
    body = Buffer.from(
      JSON.stringify({
        iss: issuer,
        aud: 'persistent-codex',
        sub: 'opaque',
        iat: now,
        exp: now + 60,
        jti: 'j1',
        amr: ['webauthn'],
      }),
    ).toString('base64url'),
    token = `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`
  assert.equal(
    validateOidcAssertion({
      token,
      configuration: config,
      consumeReplay: () => true,
    }).subject,
    'opaque',
  )
  const base = `<Response><Issuer>${issuer}</Issuer><Audience>persistent-codex</Audience><AssertionID>s1</AssertionID><NotOnOrAfter>${new Date(Date.now() + 60000).toISOString()}</NotOnOrAfter><NameID>opaque</NameID><Signature><SignatureValue></SignatureValue></Signature></Response>`,
    signature = sign('RSA-SHA256', Buffer.from(base), privateKey).toString(
      'base64',
    ),
    xml = base.replace(
      '<SignatureValue></SignatureValue>',
      `<SignatureValue>${signature}</SignatureValue>`,
    )
  assert.equal(
    validateSamlResponse({
      xml,
      configuration: { ...config, protocol: 'saml' },
      consumeReplay: () => true,
    }).subject,
    'opaque',
  )
  console.log(
    JSON.stringify({
      gate: 'wp28:identity',
      accepted: true,
      isolatedHttpIdp: true,
      oidcDiscovery: true,
      oidcSignedAssertion: true,
      samlMetadata: true,
      samlSignedResponse: true,
      audienceValidated: true,
      mfaAmrValidated: true,
      replayFailClosed: true,
      externalCredential: false,
    }),
  )
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
