import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const corpusRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wikiRoot = join(corpusRoot, 'wiki')
const sourceRegistryPath = join(corpusRoot, 'sources', 'index.md')
const requiredPaths = [
  join(corpusRoot, 'AGENTS.md'),
  join(corpusRoot, 'README.md'),
  join(corpusRoot, 'log.md'),
  sourceRegistryPath,
  join(wikiRoot, 'index.md'),
]
const errors = []

for (const path of requiredPaths) {
  if (!existsSync(path))
    errors.push(`required file missing: ${relative(corpusRoot, path)}`)
}

function markdownFiles(root) {
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    if (entry.isDirectory()) return markdownFiles(path)
    return entry.isFile() && extname(entry.name) === '.md' ? [path] : []
  })
}

const registry = existsSync(sourceRegistryPath)
  ? readFileSync(sourceRegistryPath, 'utf8')
  : ''
const registeredIds = new Set(
  registry.match(/SRC-(?:REPO|ADR|EXT|NOTE)-\d+/g) ?? [],
)
const wikiFiles = markdownFiles(wikiRoot)

for (const path of wikiFiles) {
  const content = readFileSync(path, 'utf8')
  const name = relative(corpusRoot, path)
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!frontmatter) {
    errors.push(`${name}: YAML frontmatter missing`)
    continue
  }
  for (const field of [
    'title:',
    'kind:',
    'status:',
    'updated:',
    'source_ids:',
    'tags:',
  ]) {
    if (!frontmatter[1].includes(field))
      errors.push(`${name}: frontmatter field missing: ${field}`)
  }
  if (!content.includes('\n## Özet\n'))
    errors.push(`${name}: required heading missing: ## Özet`)
  const sourceIds = frontmatter[1].match(/SRC-(?:REPO|ADR|EXT|NOTE)-\d+/g) ?? []
  for (const sourceId of sourceIds) {
    if (!registeredIds.has(sourceId))
      errors.push(`${name}: unregistered source id: ${sourceId}`)
  }
  const links = content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)
  for (const match of links) {
    const target = match[1].split('#', 1)[0]
    if (!target || /^[a-z]+:/i.test(target)) continue
    const resolved = resolve(dirname(path), decodeURIComponent(target))
    if (!existsSync(resolved)) errors.push(`${name}: broken link: ${target}`)
    else if (statSync(resolved).isDirectory())
      errors.push(`${name}: link targets a directory: ${target}`)
  }
}

const wikiIndex = join(wikiRoot, 'index.md')
const indexContent = existsSync(wikiIndex)
  ? readFileSync(wikiIndex, 'utf8')
  : ''
for (const path of wikiFiles) {
  if (path === wikiIndex) continue
  const fileName = relative(wikiRoot, path)
  if (!indexContent.includes(`](${fileName})`))
    errors.push(`wiki/${fileName}: not linked from wiki/index.md`)
}

if (errors.length > 0) {
  console.error(`corpus lint failed (${errors.length})`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(
    `corpus lint passed (${wikiFiles.length} wiki pages, ${registeredIds.size} sources)`,
  )
}
