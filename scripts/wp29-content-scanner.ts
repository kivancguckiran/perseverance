import { sha256 } from '../packages/release-supply-chain/src/index'

export interface ContentSource {
  readonly name: string
  readonly content: string
}

export const scanWp29Content = (sources: readonly ContentSource[]) => {
  const rules = [
    { id: 'OPENAI_KEY', pattern: /\bsk-(?:proj|live)-[A-Za-z0-9_-]{20,}\b/g },
    { id: 'JWT_BEARER', pattern: /\bBearer\s+eyJ[A-Za-z0-9._-]{40,}\b/g },
    {
      id: 'PRIVATE_KEY',
      pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
    },
    {
      id: 'TENANT_CONTENT_MARKER',
      pattern: /WP29_TENANT_CONTENT_[A-Za-z0-9_-]+/g,
    },
    {
      id: 'PROMPT_OUTPUT_MARKER',
      pattern: /WP29_(?:PROMPT|MODEL_OUTPUT)_SECRET_[A-Za-z0-9_-]+/g,
    },
    {
      id: 'PROVIDER_CREDENTIAL',
      pattern: /WP29_PROVIDER_CREDENTIAL_[A-Za-z0-9_-]+/g,
    },
  ]
  const findings = sources.flatMap(({ name, content }) =>
    rules.flatMap(({ id, pattern }) => {
      pattern.lastIndex = 0
      return pattern.test(content) ? [{ source: name, ruleId: id }] : []
    }),
  )
  return {
    scanner: 'wp29-evidence-content-scanner-v1',
    passed: findings.length === 0,
    sourcesScanned: sources.length,
    bytesScanned: sources.reduce(
      (sum, { content }) => sum + Buffer.byteLength(content),
      0,
    ),
    inputSha256: sha256(
      sources.map(({ name, content }) => `${name}\0${content}`).join('\0'),
    ),
    findings,
  }
}
