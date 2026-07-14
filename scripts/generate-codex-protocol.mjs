import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const EXPECTED_CODEX_VERSION = 'codex-cli 0.144.2'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageRoot = join(root, 'packages/codex-protocol-generated')
const generatedRoot = join(packageRoot, 'src/generated')

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    )
  return value
}

function semanticallyEqual(leftRoot, rightRoot) {
  const leftFiles = listFiles(leftRoot)
    .map((file) => relative(leftRoot, file))
    .toSorted()
  const rightFiles = listFiles(rightRoot)
    .map((file) => relative(rightRoot, file))
    .toSorted()
  if (JSON.stringify(leftFiles) !== JSON.stringify(rightFiles)) return false
  return leftFiles.every((name) => {
    const left = readFileSync(join(leftRoot, name), 'utf8')
    const right = readFileSync(join(rightRoot, name), 'utf8')
    if (!name.endsWith('.json')) return left === right
    return (
      JSON.stringify(canonical(JSON.parse(left))) ===
      JSON.stringify(canonical(JSON.parse(right)))
    )
  })
}

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

const stagingRoot = mkdtempSync(join(tmpdir(), 'persistent-codex-protocol-'))
mkdirSync(join(stagingRoot, 'typescript'), { recursive: true })
mkdirSync(join(stagingRoot, 'json-schema'), { recursive: true })

runCodex([
  'app-server',
  'generate-ts',
  '--out',
  join(stagingRoot, 'typescript'),
])
runCodex([
  'app-server',
  'generate-json-schema',
  '--out',
  join(stagingRoot, 'json-schema'),
])

// Codex 0.144.2 serializes some JSON Schema maps in nondeterministic key order.
// Preserve the committed byte representation when a fresh generation is semantically
// identical; real schema or TypeScript changes still replace the complete tree.
if (!semanticallyEqual(generatedRoot, stagingRoot)) {
  rmSync(generatedRoot, { recursive: true, force: true })
  renameSync(stagingRoot, generatedRoot)
} else {
  rmSync(stagingRoot, { recursive: true, force: true })
}

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
