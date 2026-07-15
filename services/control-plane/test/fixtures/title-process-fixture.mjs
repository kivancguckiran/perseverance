const mode = process.argv[2]
if (mode === 'timeout') setInterval(() => {}, 1000)
else if (mode === 'bytes') console.log('x'.repeat(2048))
else if (mode === 'lines')
  for (let index = 0; index < 5; index += 1) console.log('{}')
else {
  console.log(
    JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'Güvenli başlık' },
    }),
  )
  console.log(
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 4, output_tokens: 2 },
    }),
  )
}
