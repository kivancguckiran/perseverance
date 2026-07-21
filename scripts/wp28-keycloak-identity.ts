import assert from 'node:assert/strict'
import {
  createHash,
  createHmac,
  createPublicKey,
  randomBytes,
} from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as samlify from 'samlify'
import * as xsdValidator from '@authenio/samlify-xsd-schema-validator'
import { validateOidcAssertion } from '../packages/enterprise-lifecycle/src/identity'
import type { FederationConfiguration } from '../packages/enterprise-lifecycle/src/contracts'

const name = `persistent-wp28-keycloak-${randomBytes(6).toString('hex')}`,
  docker = (args: string[], allow = false) => {
    const r = spawnSync('docker', args, { encoding: 'utf8' })
    if (!allow && r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  },
  realmPath = `${process.cwd()}/infra/keycloak/wp28-realm.json`
const samlTemp = mkdtempSync(join(tmpdir(), 'wp28-saml-')),
  samlKey = join(samlTemp, 'sp.key'),
  samlCert = join(samlTemp, 'sp.crt')
assert.equal(
  spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=wp28-saml-sp',
    '-keyout',
    samlKey,
    '-out',
    samlCert,
    '-days',
    '1',
  ]).status,
  0,
)
samlify.setSchemaValidator(xsdValidator)
const decodeEntities = (s: string) =>
  s.replaceAll('&amp;', '&').replaceAll('&#39;', "'").replaceAll('&quot;', '"')
const base32 = (value: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of value)
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  return Buffer.from(
    bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)),
  )
}
const totp = (secret: string, at = Date.now()) => {
  const key = base32(secret.replaceAll(/\s+/g, '').toUpperCase()),
    counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000)))
  const digest = createHmac('sha1', key).update(counter).digest(),
    offset = digest.at(-1)! & 15
  return String(
    (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000,
  ).padStart(6, '0')
}
let enrolledTotpSecret = '',
  lastOtpCounter = -1
const login = async (start: string) => {
  const trace: string[] = []
  let response = await fetch(start, { redirect: 'manual' }),
    cookie = ''
  for (let step = 0; step < 8; step++) {
    for (const value of response.headers.getSetCookie?.() ?? [])
      cookie = `${cookie}; ${value.split(';')[0]}`
    const location = response.headers.get('location')
    if (location) {
      if (location.includes('/oidc/callback')) return { location, html: '' }
      response = await fetch(new URL(location, response.url), {
        redirect: 'manual',
        headers: { cookie },
      })
      continue
    }
    let html = await response.text()
    if (/id=["']mode-manual["']/.test(html) && !enrolledTotpSecret) {
      const manual = decodeEntities(
        /<a[^>]+href=["']([^"']+)["'][^>]+id=["']mode-manual["']/i.exec(
          html,
        )?.[1] ?? '',
      )
      assert(manual, 'Keycloak manual OTP enrollment link missing')
      response = await fetch(new URL(manual, response.url), {
        redirect: 'manual',
        headers: { cookie },
      })
      for (const value of response.headers.getSetCookie?.() ?? [])
        cookie = `${cookie}; ${value.split(';')[0]}`
      html = await response.text()
      enrolledTotpSecret = (
        /id=["']kc-totp-secret-key["'][^>]*>([^<]+)</i.exec(html)?.[1] ?? ''
      ).replaceAll(/\s+/g, '')
      assert(enrolledTotpSecret, 'Keycloak encoded OTP secret missing')
    }
    trace.push(
      `${step}:${/name=["']username/.test(html) ? 'password' : /name=["'](?:otp|totp)/.test(html) ? 'otp' : /name=["']SAMLResponse/.test(html) ? 'saml' : 'other'}:${response.status}`,
    )
    if (trace.at(-1)?.includes(':other:'))
      throw new Error(
        `KEYCLOAK_UNEXPECTED_PAGE:${html.replaceAll(/\s+/g, ' ').slice(-1800)}`,
      )
    if (/name=["']SAMLResponse/.test(html)) return { location: '', html }
    const action = decodeEntities(
      /action\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] ?? '',
    )
    assert(
      action,
      `Keycloak login form missing at step ${step}: ${html.replaceAll(/\s+/g, ' ').slice(-2200)}`,
    )
    const values = new URLSearchParams()
    for (const match of html.matchAll(/<input[^>]*>/gi)) {
      const name = /name=["']([^"']+)["']/i.exec(match[0])?.[1]
      const value = /value=["']([^"']*)["']/i.exec(match[0])?.[1]
      if (name && value !== undefined) values.set(name, decodeEntities(value))
    }
    if (/name=["']username/.test(html)) {
      values.set('username', 'wp28-user')
      values.set('password', 'Wp28-Strong-Password!')
    }
    if (/name=["'](?:otp|totp)/.test(html)) {
      const secret = enrolledTotpSecret
      assert(secret, 'Keycloak OTP form did not expose its enrollment secret')
      const serverDate = Date.parse(response.headers.get('date') ?? '')
      const serverOffset = Number.isFinite(serverDate)
        ? serverDate - Date.now()
        : 0
      let at = Date.now() + serverOffset,
        counter = Math.floor(at / 30000)
      if (counter <= lastOtpCounter) {
        await new Promise((resolve) =>
          setTimeout(resolve, (lastOtpCounter + 1) * 30000 - at + 500),
        )
        at = Date.now() + serverOffset
        counter = Math.floor(at / 30000)
      }
      values.set(
        /name=["']totp["']/.test(html) ? 'totp' : 'otp',
        totp(secret, at),
      )
      lastOtpCounter = counter
      if (values.has('userLabel')) values.set('userLabel', 'WP28 acceptance')
    }
    response = await fetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: values,
    })
  }
  throw new Error(`KEYCLOAK_LOGIN_FLOW_EXHAUSTED:${trace.join(',')}`)
}
try {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--label',
    'persistent.wp28=true',
    '--tmpfs',
    '/tmp:size=512m,mode=1777',
    '--tmpfs',
    '/opt/keycloak/data:size=1024m',
    '-e',
    'KC_BOOTSTRAP_ADMIN_USERNAME=admin',
    '-e',
    'KC_BOOTSTRAP_ADMIN_PASSWORD=wp28-admin-fixture',
    '-v',
    `${realmPath}:/opt/keycloak/data/import/wp28-realm.json:ro`,
    '-p',
    '127.0.0.1::8080',
    'quay.io/keycloak/keycloak:26.3.2',
    'start-dev',
    '--import-realm',
    '--health-enabled=true',
  ])
  const port = Number(docker(['port', name, '8080/tcp']).split(':').at(-1)),
    base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 480; i++) {
    if (
      (
        await fetch(
          `${base}/realms/wp28/.well-known/openid-configuration`,
        ).catch(() => null)
      )?.ok
    )
      break
    if (i === 479) throw new Error('KEYCLOAK_READINESS_TIMEOUT')
    await new Promise((r) => setTimeout(r, 500))
  }
  const discovery = (await (
      await fetch(`${base}/realms/wp28/.well-known/openid-configuration`)
    ).json()) as any,
    redirect = 'http://127.0.0.1:43128/oidc/callback'
  const adminToken = (await (
      await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'wp28-admin-fixture',
        }),
      })
    ).json()) as any,
    adminHeaders = {
      authorization: `Bearer ${adminToken.access_token}`,
      'content-type': 'application/json',
    },
    flows = (await (
      await fetch(`${base}/admin/realms/wp28/authentication/flows`, {
        headers: adminHeaders,
      })
    ).json()) as any[]
  const references = new Map([
    ['auth-username-password-form', 'pwd'],
    ['auth-otp-form', 'otp'],
  ])
  const configuredReferences = new Set<string>()
  for (const flow of flows) {
    const executions = (await (
      await fetch(
        `${base}/admin/realms/wp28/authentication/flows/${encodeURIComponent(flow.alias)}/executions`,
        { headers: adminHeaders },
      )
    ).json()) as any[]
    for (const execution of executions) {
      const reference = references.get(execution.providerId)
      if (!reference || configuredReferences.has(reference)) continue
      const configured = await fetch(
        `${base}/admin/realms/wp28/authentication/executions/${execution.id}/config`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            alias: `wp28-amr-${reference}`,
            config: {
              'default.reference.value': reference,
              'default.reference.maxAge': '300',
            },
          }),
        },
      )
      assert([201, 204].includes(configured.status))
      configuredReferences.add(reference)
    }
  }
  assert.deepEqual([...configuredReferences].sort(), ['otp', 'pwd'])
  const authorizationCodeLogin = async () => {
    const verifier = randomBytes(32).toString('base64url'),
      challenge = createHash('sha256').update(verifier).digest('base64url'),
      state = randomBytes(12).toString('hex'),
      authorize = new URL(discovery.authorization_endpoint)
    for (const [k, v] of Object.entries({
      client_id: 'wp28-oidc',
      redirect_uri: redirect,
      response_type: 'code',
      scope: 'openid',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      nonce: randomBytes(12).toString('hex'),
    }))
      authorize.searchParams.set(k, v)
    const flow = await login(authorize.href),
      callback = new URL(flow.location)
    assert.equal(callback.searchParams.get('state'), state)
    const tokenResponse = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: 'wp28-oidc',
        redirect_uri: redirect,
        code: String(callback.searchParams.get('code')),
        code_verifier: verifier,
      }),
    })
    assert.equal(tokenResponse.status, 200)
    return tokenResponse.json() as Promise<any>
  }
  // First login enrolls the real TOTP credential; the second requires and
  // records password + OTP as authentication methods in the issued token.
  await authorizationCodeLogin()
  const tokens = await authorizationCodeLogin(),
    header = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[0], 'base64url').toString(),
    ),
    claims = JSON.parse(
      Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString(),
    ),
    jwks = (await (await fetch(discovery.jwks_uri)).json()) as any,
    jwk = jwks.keys.find((key: any) => key.kid === header.kid)
  assert(jwk)
  const pem = createPublicKey({ key: jwk, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' })
      .toString(),
    configuration: FederationConfiguration = {
      schemaVersion: 1,
      tenantId: 'tenant-a',
      organizationId: 'tenant-a',
      configurationId: 'keycloak',
      protocol: 'oidc',
      issuer: discovery.issuer,
      entityId: null,
      audience: 'wp28-oidc',
      callbackUrl: redirect,
      acsUrl: null,
      keyId: header.kid,
      verificationKeyPem: pem,
      clockSkewSeconds: 30,
      enforcedSso: true,
      requiredMfa: true,
      allowedAmr: ['otp'],
      metadataVersion: 1,
      enabled: true,
      updatedAt: new Date().toISOString(),
    }
  let consumed = false
  validateOidcAssertion({
    token: tokens.id_token,
    configuration,
    consumeReplay: () => !consumed && (consumed = true),
  })
  assert.throws(
    () =>
      validateOidcAssertion({
        token: tokens.id_token,
        configuration,
        consumeReplay: () => false,
      }),
    /OIDC_REPLAY/,
  )
  assert(
    Array.isArray(claims.amr) && claims.amr.includes('otp'),
    'real IdP OTP assurance missing',
  )
  const metadata = await (
      await fetch(`${base}/realms/wp28/protocol/saml/descriptor`)
    ).text(),
    sp = samlify.ServiceProvider({
      entityID: 'http://wp28.test/saml',
      privateKey: readFileSync(samlKey),
      signingCert: readFileSync(samlCert),
      authnRequestsSigned: true,
      assertionConsumerService: [
        {
          Binding: samlify.Constants.namespace.binding.post,
          Location: 'http://127.0.0.1:43128/saml/acs',
        },
      ],
    }),
    idp = samlify.IdentityProvider({ metadata }),
    request = sp.createLoginRequest(idp, 'redirect'),
    samlFlow = await login(request.context),
    samlResponse = decodeEntities(
      /name="SAMLResponse"[^>]+value="([^"]+)"/i.exec(samlFlow.html)?.[1] ?? '',
    )
  assert(samlResponse)
  const parsed = await sp.parseLoginResponse(idp, 'post', {
    body: { SAMLResponse: samlResponse },
  })
  assert(parsed.extract.nameID)
  const rotationToken = (await (
      await fetch(`${base}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'wp28-admin-fixture',
        }),
      })
    ).json()) as any,
    rotationHeaders = {
      authorization: `Bearer ${rotationToken.access_token}`,
      'content-type': 'application/json',
    }
  const realm = (await (
    await fetch(`${base}/admin/realms/wp28`, { headers: rotationHeaders })
  ).json()) as any
  const rotate = await fetch(`${base}/admin/realms/wp28/components`, {
    method: 'POST',
    headers: rotationHeaders,
    body: JSON.stringify({
      name: 'wp28-rotated-rsa',
      providerId: 'rsa-generated',
      providerType: 'org.keycloak.keys.KeyProvider',
      parentId: realm.id,
      config: {
        priority: ['200'],
        enabled: ['true'],
        active: ['true'],
        algorithm: ['RS256'],
        keySize: ['2048'],
      },
    }),
  })
  assert([201, 204].includes(rotate.status))
  const rotated = (await (await fetch(discovery.jwks_uri)).json()) as any
  assert(rotated.keys.length > jwks.keys.length)
  console.log(
    JSON.stringify({
      gate: 'wp28:identity',
      accepted: true,
      idp: 'Keycloak 26.3.2',
      oidcAuthorizationCodePkce: true,
      realJwks: true,
      keyRotation: true,
      samlMetadata: true,
      samlAuthnRequest: true,
      signedResponseValidatedBy: 'samlify',
      acsParsed: true,
      idpAssurance: { amr: claims.amr ?? [], acr: claims.acr },
      replayRejected: true,
      issuerAudienceExpiryClockSkew: true,
      syntheticAssertion: false,
    }),
  )
} finally {
  docker(['rm', '-f', '-v', name], true)
  rmSync(samlTemp, { recursive: true, force: true })
}
