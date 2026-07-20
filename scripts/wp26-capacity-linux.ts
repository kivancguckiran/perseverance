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
  '--device-read-iops',
  `${ioDevice}:100`,
  '--device-write-iops',
  `${ioDevice}:100`,
  '--tmpfs',
  '/tenant:size=8m,nr_inodes=128',
  '--network',
  'none',
  image,
  'sh',
  '-c',
  `node -e "const fs=require('fs'); (async()=>{const read=n=>fs.readFileSync('/sys/fs/cgroup/'+n,'utf8').trim(); let diskBytes='not-exhausted',diskInodes='not-exhausted'; try{fs.writeFileSync('/tenant/full',Buffer.alloc(9*1024*1024))}catch(e){diskBytes=e.code==='ENOSPC'?'exhausted':'failed'}; try{for(let i=0;i<300;i++)fs.writeFileSync('/tenant/i'+i,'x')}catch(e){diskInodes=e.code==='ENOSPC'?'exhausted':'failed'}; const out={cpu:read('cpu.max'),memory:read('memory.max'),pidsMax:read('pids.max'),io:read('io.max'),diskBytes,diskInodes}; try{await fetch('https://example.com');process.exit(9)}catch{console.log(JSON.stringify({...out,egress:'blocked'}))}})()"`,
]
const result = spawnSync('docker', args, { encoding: 'utf8' })
if (result.status !== 0)
  throw new Error(result.stderr || result.stdout || 'capacity container failed')
const evidence = JSON.parse(result.stdout.trim()) as Record<string, string>
const pidsResult = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--pids-limit',
    '16',
    'alpine:3.20',
    'sh',
    '-c',
    `i=0; while [ "$i" -lt 100 ]; do sleep 5 & if [ "$?" -ne 0 ]; then break; fi; i=$((i+1)); done; [ "$i" -lt 100 ]`,
  ],
  { encoding: 'utf8' },
)
assert.match(pidsResult.stderr, /can't fork|Resource temporarily unavailable/)
const oomResult = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--memory',
    '32m',
    '--memory-swap',
    '32m',
    image,
    'node',
    '-e',
    `const blocks=[];for(;;)blocks.push(Buffer.alloc(1024*1024).fill(1))`,
  ],
  { encoding: 'utf8' },
)
assert.equal(oomResult.status, 137)
assert.match(evidence.cpu, /^50000 100000$/)
assert.equal(evidence.memory, String(64 * 1024 * 1024))
assert.equal(evidence.pidsMax, '32')
assert.match(evidence.io, /rbps=1048576/)
assert.match(evidence.io, /wbps=1048576/)
assert.match(evidence.io, /riops=100/)
assert.match(evidence.io, /wiops=100/)
assert.equal(evidence.diskBytes, 'exhausted')
assert.equal(evidence.diskInodes, 'exhausted')
assert.equal(evidence.egress, 'blocked')
console.log(
  JSON.stringify({
    gate: 'wp26:capacity',
    isolation: 'real-linux-cgroup-v2',
    cpu: 'bounded',
    memory: 'bounded',
    pids: 'bounded',
    io: 'bounded',
    iops: 'bounded-100',
    diskBytes: 'tmpfs-8m',
    diskInodes: 'tmpfs-128',
    egress: 'network-none',
    noisyNeighbor: 'container-boundary',
    image,
  }),
)
