import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const EXPECTED_CODEX_VERSION = 'codex-cli 0.144.2'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(root, 'packages/codex-protocol-generated')
const generatedRoot = join(packageRoot, 'src/generated')

function runCodex(args) {
  const result = spawnSync('codex', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }

  return result.stdout.trim()
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
}

const installedVersion = runCodex(['--version'])
if (installedVersion !== EXPECTED_CODEX_VERSION) {
  throw new Error(
    `Expected ${EXPECTED_CODEX_VERSION}, received ${installedVersion}. Update the pin through an ADR before regenerating.`,
  )
}

rmSync(generatedRoot, { recursive: true, force: true })
mkdirSync(join(generatedRoot, 'typescript'), { recursive: true })
mkdirSync(join(generatedRoot, 'json-schema'), { recursive: true })

runCodex([
  'app-server',
  'generate-ts',
  '--out',
  join(generatedRoot, 'typescript'),
])
runCodex([
  'app-server',
  'generate-json-schema',
  '--out',
  join(generatedRoot, 'json-schema'),
])

const files = listFiles(generatedRoot).toSorted()
const hash = createHash('sha256')
for (const file of files) {
  hash.update(relative(generatedRoot, file))
  hash.update('\0')
  hash.update(readFileSync(file))
  hash.update('\0')
}

writeFileSync(
  join(packageRoot, 'protocol-manifest.json'),
  `${JSON.stringify(
    {
      codexVersion: installedVersion.replace('codex-cli ', ''),
      schemaHash: `sha256:${hash.digest('hex')}`,
      transport: 'stdio-jsonl',
    },
    null,
    2,
  )}\n`,
)
