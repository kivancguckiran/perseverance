const mode = process.argv[2]

if (mode === 'ignore-signals') {
  process.on('SIGINT', () => {})
  process.on('SIGTERM', () => {})
} else if (mode === 'interrupt-exit') {
  process.on('SIGINT', () => {
    process.stderr.write('interrupted by fixture\n')
    process.exit(130)
  })
}
if (mode === 'oversized-line') {
  process.stdout.write('x'.repeat(4096) + '\n')
}

console.log(
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'fixture-session',
  }),
)
console.log(JSON.stringify({ type: 'ready', mode }))

if (mode === 'complete') {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'fixture-session',
    }),
  )
} else if (mode !== 'oversized-line') {
  setInterval(() => {}, 1_000)
}
