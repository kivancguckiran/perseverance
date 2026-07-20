const localAlpha = process.env.PERSISTENT_CODEX_LOCAL_ALPHA === '1'

if (localAlpha) {
  await import('./main')
} else {
  const { buildProductionControlPlaneFromEnv } =
    await import('./production-server')
  const app = await buildProductionControlPlaneFromEnv(process.env)
  const port = Number.parseInt(process.env.PORT ?? '3100', 10)
  const host = process.env.HOST ?? '0.0.0.0'
  await app.listen({ host, port })
  let closing = false
  const close = async () => {
    if (closing) return
    closing = true
    await app.close()
  }
  process.once('SIGTERM', () => void close())
  process.once('SIGINT', () => void close())
}
