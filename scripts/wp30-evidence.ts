import { createHash } from 'node:crypto'

export interface EvidenceSource {
  name: string
  content: string
}

const patterns = [
  { id: 'OPENAI_KEY', value: /\bsk-(?:proj|live)-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'BEARER', value: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/gi },
  {
    id: 'JWT',
    value: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: 'PRIVATE_KEY',
    value: /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/g,
  },
  { id: 'COOKIE', value: /\b(?:set-cookie|cookie):[^\n]{8,}/gi },
  {
    id: 'SECRET_ASSIGNMENT',
    value:
      /\b(?:api[_-]?key|token|secret|password)\s*[=:]\s*["']?[^\s,"']{8,}/gi,
  },
  {
    id: 'DATABASE_URI_USERINFO',
    value:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s:/]+:[^\s@/]+@/gi,
  },
  {
    id: 'AWS_ACCESS_KEY',
    value: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'PROMPT_CONTENT',
    value: /WP30_(?:PROMPT|USER_CONTENT|DECRYPTED)_[A-Za-z0-9_-]+/g,
  },
]

export const redactWp30Evidence = (content: string) => {
  let redacted = content
  for (const pattern of patterns) {
    pattern.value.lastIndex = 0
    redacted = redacted.replace(pattern.value, `[REDACTED:${pattern.id}]`)
  }
  return redacted
}

export const scanWp30Evidence = (sources: readonly EvidenceSource[]) => {
  const findings = sources.flatMap(({ name, content }) =>
    patterns.flatMap(({ id, value }) => {
      value.lastIndex = 0
      return value.test(content) ? [{ source: name, ruleId: id }] : []
    }),
  )
  return {
    scanner: 'wp30-evidence-content-scanner-v1',
    passed: findings.length === 0,
    sourcesScanned: sources.length,
    bytesScanned: sources.reduce(
      (sum, source) => sum + Buffer.byteLength(source.content),
      0,
    ),
    inputSha256: createHash('sha256')
      .update(
        sources.map(({ name, content }) => `${name}\0${content}`).join('\0'),
      )
      .digest('hex'),
    findings,
  }
}

export const machineEvidence = (gate: string, value: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ gate, ...value })}\n`)

export const failNotRun = (gate: string, missing: readonly string[]): never => {
  machineEvidence(gate, {
    accepted: false,
    status: 'not-run',
    missing: [...missing].sort(),
    productionEvidence: false,
  })
  process.exitCode = 1
  throw new Error(`${gate} not-run: ${missing.join(', ')}`)
}
