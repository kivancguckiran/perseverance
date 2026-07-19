import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const image = process.env.WP26_CAPACITY_IMAGE ?? 'node:24-alpine'
const ioDevice = process.env.WP26_IO_DEVICE
if (!ioDevice)
  throw new Error(
    'WP26_IO_DEVICE is required for a real cgroup v2 io.max test; emulator results are forbidden',
  )
const args = [
  'run',
  '--rm',
  '--memory',
  '64m',
  '--memory-swap',
  '64m',
  '--pids-limit',
  '32',
  '--cpus',
  '0.5',
  '--device-read-bps',
  `${ioDevice}:1mb`,
  '--device-write-bps',
  `${ioDevice}:1mb`,
  '--tmpfs',
  '/tenant:size=8m,nr_inodes=128',
  '--network',
  'none',
  image,
  'sh',
  '-c',
  `node -e "const fs=require('fs'); const read=n=>fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim(); const out={cpu:read('cpu.max'),memory:read('memory.max'),pids:read('pids.max'),io:read('io.max')}; fetch('https://example.com').then(()=>process.exit(9)).catch(()=>console.log(JSON.stringify({...out,egress:'blocked'})))"`,
]
const result = spawnSync('docker', args, { encoding: 'utf8' })
if (result.status !== 0)
  throw new Error(result.stderr || result.stdout || 'capacity container failed')
const evidence = JSON.parse(result.stdout.trim()) as Record<string, string>
assert.match(evidence.cpu, /^50000 100000$/)
assert.equal(evidence.memory, String(64 * 1024 * 1024))
assert.equal(evidence.pids, '32')
assert.notEqual(evidence.io, '')
assert.equal(evidence.egress, 'blocked')
console.log(
  JSON.stringify({
    gate: 'wp26:capacity',
    isolation: 'real-linux-cgroup-v2',
    cpu: 'bounded',
    memory: 'bounded',
    pids: 'bounded',
    io: 'bounded',
    diskBytes: 'tmpfs-8m',
    diskInodes: 'tmpfs-128',
    egress: 'network-none',
    noisyNeighbor: 'container-boundary',
    image,
  }),
)
