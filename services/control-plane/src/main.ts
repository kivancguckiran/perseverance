import { buildControlPlane } from './server'

const port = Number.parseInt(process.env.PORT ?? '3100', 10)
const app = await buildControlPlane({
  databasePath: process.env.EVENT_DATABASE_PATH ?? '.runtime/events.sqlite',
  workspaceCwd: process.env.WORKSPACE_CWD ?? process.cwd(),
  logger: true,
})

await app.listen({ host: '127.0.0.1', port })
