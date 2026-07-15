const mode = process.argv[2]

console.log(
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'fixture-session',
  }),
)

if (mode === 'complete') {
  console.log(
    JSON.stringify({
      type: 'result',
      subtype: 'success',
      session_id: 'fixture-session',
    }),
  )
} else {
  if (mode === 'ignore-signals') {
    process.on('SIGINT', () => {})
    process.on('SIGTERM', () => {})
  } else {
    process.on('SIGINT', () => {
      process.stderr.write('interrupted by fixture\n')
      process.exit(130)
    })
  }
  setInterval(() => {}, 1_000)
}
