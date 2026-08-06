import { readFileSync } from 'node:fs'
import { buildContentKeyBroker } from './server'

const required = (name: string) => {
  const value = process.env[name]
  if (!value) throw new Error(`Content-key broker requires ${name}`)
  return value
}

const internalToken = readFileSync(
  required('INTERNAL_RUNTIME_TOKEN_FILE'),
  'utf8',
).trim()
const app = await buildContentKeyBroker({
  internalToken,
  ttlMs: Number(process.env.CONTENT_KEY_LEASE_TTL_SECONDS ?? 12 * 3600) * 1000,
  auditEndpoint: required('CONTENT_KEY_AUDIT_URL'),
})
const shutdown = async () => {
  await app.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
await app.listen({
  host: process.env.HOST ?? '0.0.0.0',
  port: Number(process.env.PORT ?? 3305),
})
