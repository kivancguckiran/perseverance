import { buildProductionControlPlaneFromEnv } from './production-server'

const server = await buildProductionControlPlaneFromEnv(process.env)
const shutdown = async () => {
  await server.close()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
await server.listen({
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3200),
})
