export type EvidenceSource = { name: string; content: string | Uint8Array }

const signatures = [
  {
    category: 'piiEmail',
    expression: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  },
  {
    category: 'identityAssertion',
    expression: /<(?:saml2?:)?Assertion\b|SAMLResponse=/i,
  },
  {
    category: 'token',
    expression:
      /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Authorization:\s*Bearer\s+\S+/i,
  },
  {
    category: 'secret',
    expression:
      /Wp28-Strong-Password!|wp28-admin-fixture|wp28-secret-marker|wp28-vault-root-marker|wp28-scim-bearer-marker/i,
  },
  {
    category: 'providerCredential',
    expression: /wp28-provider-credential-marker|bearer-a|bearer-b/i,
  },
  {
    category: 'exportPlaintext',
    expression: /WP28_EXPORT_PLAINTEXT_MARKER_9f31/i,
  },
] as const

export function scanWp28Evidence(sources: EvidenceSource[]) {
  const findings: Array<{ source: string; category: string }> = []
  let bytesScanned = 0
  for (const source of sources) {
    const content =
      typeof source.content === 'string'
        ? source.content
        : Buffer.from(source.content).toString('utf8')
    bytesScanned += Buffer.byteLength(content)
    for (const signature of signatures)
      if (signature.expression.test(content))
        findings.push({ source: source.name, category: signature.category })
  }
  const safe = (category: string) =>
    !findings.some((finding) => finding.category === category)
  return {
    scanner: 'wp28-evidence-scanner-v1',
    sourcesScanned: sources.length,
    bytesScanned,
    findings,
    contentSafety: {
      pii: safe('piiEmail'),
      email: safe('piiEmail'),
      assertion: safe('identityAssertion'),
      token: safe('token'),
      secret: safe('secret'),
      providerCredential: safe('providerCredential'),
      exportPlaintext: safe('exportPlaintext'),
    },
    passed: findings.length === 0,
  }
}
