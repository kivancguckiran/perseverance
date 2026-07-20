import { productionSchedulerWorkerFromEnv } from './production-scheduler-worker'

const worker = productionSchedulerWorkerFromEnv(process.env)
const shutdown = async () => {
  await worker.stop()
  process.exit(0)
}
process.once('SIGTERM', () => void shutdown())
process.once('SIGINT', () => void shutdown())
await worker.start()
