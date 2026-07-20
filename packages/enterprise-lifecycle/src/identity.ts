import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'
import type { FederationConfiguration } from './contracts'

export class EnterpriseBoundaryError extends Error {
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
    this.name = 'EnterpriseBoundaryError'
  }
}
const digest = (value: string) =>
  createHash('sha256').update(value).digest('hex')
const decode = (value: string) =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >

export function validateOidcAssertion(input: {
  token: string
  configuration: FederationConfiguration
  now?: Date
  consumeReplay: (digest: string, expiresAt: Date) => boolean
}) {
  const parts = input.token.split('.')
  if (parts.length !== 3) throw new EnterpriseBoundaryError('OIDC_MALFORMED')
  const header = decode(parts[0]!),
    claims = decode(parts[1]!)
  if (header.alg !== 'RS256' || header.kid !== input.configuration.keyId)
    throw new EnterpriseBoundaryError('OIDC_UNSIGNED_OR_KEY_MISMATCH')
  if (
    !verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey(input.configuration.verificationKeyPem),
      Buffer.from(parts[2]!, 'base64url'),
    )
  )
    throw new EnterpriseBoundaryError('OIDC_SIGNATURE_INVALID')
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000),
    skew = input.configuration.clockSkewSeconds
  if (
    claims.iss !== input.configuration.issuer ||
    claims.aud !== input.configuration.audience
  )
    throw new EnterpriseBoundaryError('OIDC_AUTHORITY_MISMATCH')
  if (
    typeof claims.exp !== 'number' ||
    claims.exp + skew < now ||
    typeof claims.iat !== 'number' ||
    claims.iat - skew > now
  )
    throw new EnterpriseBoundaryError('OIDC_ASSERTION_EXPIRED')
  if (
    typeof claims.jti !== 'string' ||
    !input.consumeReplay(
      digest(`${input.configuration.tenantId}:${claims.jti}`),
      new Date((claims.exp + skew) * 1000),
    )
  )
    throw new EnterpriseBoundaryError('OIDC_REPLAY')
  const amr = Array.isArray(claims.amr)
    ? claims.amr.filter((v): v is string => typeof v === 'string')
    : []
  if (
    input.configuration.requiredMfa &&
    !amr.some((v) => input.configuration.allowedAmr.includes(v))
  )
    throw new EnterpriseBoundaryError('MFA_ASSURANCE_REQUIRED')
  return {
    subject: String(claims.sub),
    amr,
    assurance: claims.acr == null ? null : String(claims.acr),
  }
}

export function validateSamlResponse(input: {
  xml: string
  configuration: FederationConfiguration
  now?: Date
  consumeReplay: (digest: string, expiresAt: Date) => boolean
}) {
  if (!/<Signature\b/.test(input.xml))
    throw new EnterpriseBoundaryError('SAML_UNSIGNED_RESPONSE')
  const field = (name: string) =>
    new RegExp(`<${name}>([^<]+)</${name}>`).exec(input.xml)?.[1]
  const issuer = field('Issuer'),
    audience = field('Audience'),
    assertionId = field('AssertionID'),
    expires = field('NotOnOrAfter'),
    signature = field('SignatureValue')
  if (
    issuer !== input.configuration.issuer ||
    audience !== input.configuration.audience
  )
    throw new EnterpriseBoundaryError('SAML_AUTHORITY_MISMATCH')
  const expiresAt = new Date(expires ?? '')
  if (
    !assertionId ||
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt.getTime() + input.configuration.clockSkewSeconds * 1000 <
      (input.now ?? new Date()).getTime()
  )
    throw new EnterpriseBoundaryError('SAML_ASSERTION_EXPIRED')
  const signed = input.xml.replace(
    /<SignatureValue>[^<]*<\/SignatureValue>/,
    '<SignatureValue></SignatureValue>',
  )
  if (
    !signature ||
    !verify(
      'RSA-SHA256',
      Buffer.from(signed),
      createPublicKey(input.configuration.verificationKeyPem),
      Buffer.from(signature, 'base64'),
    )
  )
    throw new EnterpriseBoundaryError('SAML_SIGNATURE_INVALID')
  if (
    !input.consumeReplay(
      digest(`${input.configuration.tenantId}:${assertionId}`),
      expiresAt,
    )
  )
    throw new EnterpriseBoundaryError('SAML_REPLAY')
  return { subject: field('NameID') ?? '' }
}

export function createDomainChallenge() {
  const token = randomBytes(32).toString('base64url')
  return { token, tokenDigest: digest(token) }
}
export function verifyDomainChallenge(token: string, expectedDigest: string) {
  return digest(token) === expectedDigest
}
export function assertLoginPolicy(input: {
  enforcedSso: boolean
  method: 'password' | 'oidc' | 'saml' | 'emergency'
  strongMfa: boolean
  separateCredential: boolean
}) {
  if (input.enforcedSso && input.method === 'password')
    throw new EnterpriseBoundaryError('LOCAL_LOGIN_DISABLED')
  if (
    input.method === 'emergency' &&
    (!input.strongMfa || !input.separateCredential)
  )
    throw new EnterpriseBoundaryError('BREAK_GLASS_REQUIREMENTS_NOT_MET')
}
