import { readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const mode = process.env.FAKE_APP_SERVER_MODE ?? 'normal'
const stateFile = process.env.FAKE_APP_SERVER_STATE_FILE
const lines = createInterface({ input: process.stdin })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function incrementInitializeCount() {
  if (!stateFile) return 1

  let count = 0
  try {
    count = Number.parseInt(readFileSync(stateFile, 'utf8'), 10) || 0
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  count += 1
  writeFileSync(stateFile, String(count))
  return count
}

lines.on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    const initializeCount = incrementInitializeCount()
    send({
      id: message.id,
      result: {
        userAgent: 'fake-app-server',
        platformFamily: 'unix',
        platformOs: 'test',
      },
    })

    if (
      mode === 'crash-always' ||
      (mode === 'crash-once' && initializeCount === 1)
    ) {
      setTimeout(() => process.exit(23), 5)
    }
    return
  }

  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thr_fixture' } } })
    send({
      method: 'thread/started',
      params: { thread: { id: 'thr_fixture' } },
    })
    return
  }

  if (message.method === 'test/pending-exit') {
    setTimeout(() => process.exit(17), 5)
    return
  }

  if (message.method === 'test/malformed') {
    process.stdout.write('{malformed json\n')
    return
  }

  if (message.method === 'test/timeout') return

  if (message.method === 'test/process-id') {
    send({ id: message.id, result: { pid: process.pid } })
  }
})

process.on('SIGTERM', () => process.exit(0))
