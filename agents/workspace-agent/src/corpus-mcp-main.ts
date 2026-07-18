import { createInterface } from 'node:readline'
import {
  HttpWorkspaceCorpusRetrievalClient,
  WorkspaceCorpusMcpServer,
} from './corpus-mcp'

function required(name: string) {
  const value = process.env[name]
  if (!value)
    throw new Error(`Missing required workload configuration: ${name}`)
  return value
}

const server = new WorkspaceCorpusMcpServer(
  new HttpWorkspaceCorpusRetrievalClient({
    endpoint: required('CORPUS_RETRIEVAL_ENDPOINT'),
    identity: {
      tenantId: required('CORPUS_WORKLOAD_TENANT_ID'),
      organizationId: required('CORPUS_WORKLOAD_ORGANIZATION_ID'),
      workspaceId: required('CORPUS_WORKLOAD_WORKSPACE_ID'),
      accessToken: required('CORPUS_WORKLOAD_ACCESS_TOKEN'),
    },
  }),
)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (Buffer.byteLength(line) > 64 * 1024) {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds byte limit' } })}\n`,
    )
    continue
  }
  let message: unknown
  try {
    message = JSON.parse(line)
  } catch {
    message = null
  }
  const response = await server.handle(message)
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
}
