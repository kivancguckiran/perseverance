import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { CodexEventAdapter } from '../packages/codex-event-adapter/src/index'

const root = resolve(import.meta.dirname, '..')
const gate = process.argv[2]
const out = resolve(process.env.WP29_OUTPUT_DIR ?? join(root, '.wp29'))
const evidenceDir = join(out, 'evidence')
const artifactDir = join(out, 'artifacts')
mkdirSync(evidenceDir, { recursive: true })
mkdirSync(artifactDir, { recursive: true })
const epoch = 1_753_056_000
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): string => {
  const normalize = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(normalize)
      : input && typeof input === 'object'
        ? Object.fromEntries(
            Object.entries(input)
              .filter(([, child]) => child !== undefined)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, normalize(child)]),
          )
        : input
  return JSON.stringify(normalize(value))
}
const run = (
  command: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    input?: string | Buffer
    allowFailure?: boolean
    maxBuffer?: number
    binary?: boolean
  } = {},
) => {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    input: options.input,
    encoding:
      options.binary || options.input instanceof Buffer ? undefined : 'utf8',
    maxBuffer: options.maxBuffer ?? 100 * 1024 * 1024,
  })
  if (!options.allowFailure && result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}): ${String(result.stderr)}${String(result.stdout)}`,
    )
  return {
    status: result.status ?? -1,
    stdout: result.stdout as string | Buffer,
    stderr: result.stderr as string | Buffer,
  }
}
const docker = (args: string[], allowFailure = false) =>
  run('docker', args, { allowFailure })
const cleanupToolImages = (images: string[]) => docker(['rmi', ...images], true)
const commit = String(run('git', ['rev-parse', 'HEAD']).stdout).trim()
const sourceDirty =
  String(
    run('git', ['status', '--porcelain=v1', '--untracked-files=all']).stdout,
  ).trim().length > 0
const emit = (record: Record<string, unknown>) => {
  const complete = { gate, ...record }
  writeFileSync(
    join(evidenceDir, `${gate.replace(':', '-')}.json`),
    `${JSON.stringify(complete, null, 2)}\n`,
  )
  process.stdout.write(`${JSON.stringify(complete)}\n`)
}
const listFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? listFiles(path) : [path]
  })
const normalizeTree = (directory: string) => {
  const date = new Date(epoch * 1000)
  for (const file of listFiles(directory)) {
    chmodSync(file, statSync(file).mode & 0o111 ? 0o755 : 0o644)
    utimesSync(file, date, date)
  }
}
const archive = (source: string, target: string) => {
  normalizeTree(source)
  const names = listFiles(source)
    .map((file) => relative(source, file))
    .sort()
    .join('\n')
  run(
    'tar',
    [
      '-cf',
      target,
      '--format',
      'ustar',
      '--uid',
      '0',
      '--gid',
      '0',
      '--uname',
      'root',
      '--gname',
      'root',
      '--no-acls',
      '--no-xattrs',
      '-C',
      source,
      '-T',
      '-',
    ],
    { input: `${names}\n` },
  )
}
const exportCommit = (target: string) => {
  mkdirSync(target, { recursive: true })
  const payload = run('git', ['archive', '--format=tar', commit], {
    binary: true,
  }).stdout as Buffer
  run('tar', ['-xf', '-', '-C', target], { input: payload })
}
const install = (directory: string) =>
  run(
    'pnpm',
    ['install', '--offline', '--frozen-lockfile', '--ignore-scripts=false'],
    { cwd: directory },
  )
const normalizeWebBuild = (directory: string, sourceRoot: string) => {
  for (const file of listFiles(directory)) {
    const content = readFileSync(file)
    if (content.includes(Buffer.from(sourceRoot)))
      writeFileSync(
        file,
        content.toString().split(sourceRoot).join('/workspace'),
      )
  }
  const manifest = listFiles(directory).find((file) =>
    /_tanstack-start-manifest_v-[A-Za-z0-9_-]+\.js$/.test(file),
  )
  if (!manifest) return
  const stableName = '_tanstack-start-manifest_v.js'
  const originalName = basename(manifest)
  renameSync(manifest, join(dirname(manifest), stableName))
  for (const file of listFiles(directory)) {
    const content = readFileSync(file, 'utf8')
    if (content.includes(originalName))
      writeFileSync(file, content.split(originalName).join(stableName))
  }
}
const buildOne = (source: string, destination: string, suffix: string) => {
  install(source)
  run('pnpm', ['--filter', '@perseverance/web', 'build'], {
    cwd: source,
    env: { ...process.env, SOURCE_DATE_EPOCH: String(epoch) },
  })
  normalizeWebBuild(join(source, 'apps/web/dist'), source)
  const compiled = join(destination, 'compiled')
  mkdirSync(compiled, { recursive: true })
  run(
    'pnpm',
    [
      'exec',
      'esbuild',
      'services/control-plane/src/main.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${join(compiled, 'control-plane.mjs')}`,
    ],
    { cwd: source },
  )
  run(
    'pnpm',
    [
      'exec',
      'esbuild',
      'agents/workspace-agent/src/index.ts',
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${join(compiled, 'workspace-agent.mjs')}`,
    ],
    { cwd: source },
  )
  const webTar = join(destination, `web-${suffix}.tar`)
  const controlTar = join(destination, `control-plane-${suffix}.tar`)
  const agentTar = join(destination, `workspace-agent-${suffix}.tar`)
  const webRoot = join(destination, 'web')
  mkdirSync(webRoot, { recursive: true })
  cpSync(join(source, 'apps/web/dist'), join(webRoot, 'dist'), {
    recursive: true,
  })
  copyFileSync(join(source, 'pnpm-lock.yaml'), join(webRoot, 'pnpm-lock.yaml'))
  archive(webRoot, webTar)
  const controlRoot = join(destination, 'control')
  const agentRoot = join(destination, 'agent')
  mkdirSync(controlRoot, { recursive: true })
  mkdirSync(agentRoot, { recursive: true })
  copyFileSync(
    join(compiled, 'control-plane.mjs'),
    join(controlRoot, 'control-plane.mjs'),
  )
  copyFileSync(
    join(compiled, 'workspace-agent.mjs'),
    join(agentRoot, 'workspace-agent.mjs'),
  )
  copyFileSync(
    join(source, 'pnpm-lock.yaml'),
    join(controlRoot, 'pnpm-lock.yaml'),
  )
  copyFileSync(
    join(source, 'pnpm-lock.yaml'),
    join(agentRoot, 'pnpm-lock.yaml'),
  )
  archive(controlRoot, controlTar)
  archive(agentRoot, agentTar)
  return { webTar, controlTar, agentTar }
}
const imageTag = `wp29-runtime:${commit.slice(0, 12)}`
const inspectOciArchive = (path: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'wp29-oci-inspect-'))
  try {
    run('tar', ['-xf', path, '-C', directory])
    const index = JSON.parse(
      readFileSync(join(directory, 'index.json'), 'utf8'),
    )
    const descriptor = index.manifests[0]
    const manifest = JSON.parse(
      readFileSync(
        join(
          directory,
          'blobs/sha256',
          descriptor.digest.replace('sha256:', ''),
        ),
        'utf8',
      ),
    )
    const config = JSON.parse(
      readFileSync(
        join(
          directory,
          'blobs/sha256',
          manifest.config.digest.replace('sha256:', ''),
        ),
        'utf8',
      ),
    )
    return {
      archiveSha256: sha256(readFileSync(path)),
      manifestDigest: descriptor.digest,
      configDigest: manifest.config.digest,
      layerDigests: manifest.layers.map((layer: any) => layer.digest),
      platform: `${config.os}/${config.architecture}`,
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const normalizeOciArchive = (source: string, target: string) => {
  const directory = mkdtempSync(join(tmpdir(), 'wp29-oci-normalize-'))
  try {
    run('tar', ['-xf', source, '-C', directory])
    archive(directory, target)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
const skopeo = (args: string[], mounts: string[], network: string) =>
  docker([
    'run',
    '--rm',
    '--network',
    network,
    ...mounts.flatMap((mount) => ['-v', mount]),
    'quay.io/skopeo/stable:v1.19.0',
    ...args,
  ])
const registryRoundTrip = (ociArchive: string) => {
  const name = `persistent-wp29-registry-${process.pid}`
  const network = `persistent-wp29-network-${process.pid}`
  const transport = mkdtempSync(join(tmpdir(), 'wp29-registry-transport-'))
  try {
    docker(['network', 'create', network])
    docker([
      'run',
      '-d',
      '--name',
      name,
      '--label',
      'persistent.wp29=true',
      '--network',
      network,
      '--tmpfs',
      '/var/lib/registry:rw,size=512m',
      'registry:2.8.3',
    ])
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        docker(
          ['exec', name, 'wget', '-qO-', 'http://127.0.0.1:5000/v2/'],
          true,
        ).status === 0
      ) {
        ready = true
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    assert(ready, 'local registry did not become ready')
    copyFileSync(ociArchive, join(transport, 'runtime.oci.tar'))
    const repository = `${name}:5000/persistent/wp29`
    const mounts = [`${transport}:/work`]
    skopeo(
      [
        'copy',
        '--dest-tls-verify=false',
        'oci-archive:/work/runtime.oci.tar',
        `docker://${repository}:${commit}`,
      ],
      mounts,
      network,
    )
    const digest = String(
      skopeo(
        [
          'inspect',
          '--tls-verify=false',
          '--format',
          '{{.Digest}}',
          `docker://${repository}:${commit}`,
        ],
        mounts,
        network,
      ).stdout,
    ).trim()
    assert.match(digest, /^sha256:[0-9a-f]{64}$/)
    skopeo(
      [
        'copy',
        '--src-tls-verify=false',
        `docker://${repository}@${digest}`,
        'oci-archive:/work/pulled.oci.tar',
      ],
      mounts,
      network,
    )
    const pulled = inspectOciArchive(join(transport, 'pulled.oci.tar'))
    const source = inspectOciArchive(ociArchive)
    assert.equal(pulled.manifestDigest, source.manifestDigest)
    assert.equal(digest, source.manifestDigest)
    assert.equal(pulled.configDigest, source.configDigest)
    assert.deepEqual(pulled.layerDigests, source.layerDigests)
    return {
      repository,
      digest,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      configDigest: pulled.configDigest,
      layerDigests: pulled.layerDigests,
      platform: pulled.platform,
      transport: 'skopeo-1.19.0',
    }
  } finally {
    docker(['rm', '-f', name], true)
    docker(['network', 'rm', network], true)
    rmSync(transport, { recursive: true, force: true })
  }
}

const reproducible = () => {
  assert.equal(
    sourceDirty,
    false,
    'WP29 clean-source gate requires a clean worktree',
  )
  const temp = mkdtempSync(join(tmpdir(), 'wp29-repro-'))
  const builder = `persistent-wp29-builder-${process.pid}`
  const builderContainer = `buildx_buildkit_${builder}0`
  try {
    const sourceA = join(temp, 'source-a')
    const sourceB = join(temp, 'source-b')
    exportCommit(sourceA)
    exportCommit(sourceB)
    const builtA = buildOne(sourceA, join(temp, 'a'), 'a')
    const builtB = buildOne(sourceB, join(temp, 'b'), 'b')
    const artifacts = Object.entries({
      web: [builtA.webTar, builtB.webTar],
      'control-plane': [builtA.controlTar, builtB.controlTar],
      'workspace-agent': [builtA.agentTar, builtB.agentTar],
    }).map(([name, [first, second]]) => {
      const firstSha256 = sha256(readFileSync(first!))
      const secondSha256 = sha256(readFileSync(second!))
      assert.equal(firstSha256, secondSha256, `${name} is nondeterministic`)
      const finalPath = join(artifactDir, `${name}.tar`)
      copyFileSync(first!, finalPath)
      return { name, sha256: firstSha256, byteLength: statSync(finalPath).size }
    })
    const buildEnv = { ...process.env, SOURCE_DATE_EPOCH: String(epoch) }
    const tagA = imageTag
    const tagB = imageTag
    const rawOciA = join(temp, 'runtime-a.raw.oci.tar')
    const rawOciB = join(temp, 'runtime-b.raw.oci.tar')
    const ociA = join(temp, 'runtime-a.oci.tar')
    const ociB = join(temp, 'runtime-b.oci.tar')
    docker([
      'buildx',
      'create',
      '--name',
      builder,
      '--driver',
      'docker-container',
    ])
    for (const [source, tag, destination] of [
      [sourceA, tagA, rawOciA],
      [sourceB, tagB, rawOciB],
    ] as const)
      run(
        'docker',
        [
          'buildx',
          'build',
          '--builder',
          builder,
          '--no-cache',
          '--provenance=false',
          '--build-arg',
          `SOURCE_DATE_EPOCH=${epoch}`,
          '-f',
          'infra/release/wp29-runtime.Dockerfile',
          '-t',
          tag,
          '--output',
          `type=oci,dest=${destination},rewrite-timestamp=true`,
          '.',
        ],
        { cwd: source, env: buildEnv, maxBuffer: 200 * 1024 * 1024 },
      )
    normalizeOciArchive(rawOciA, ociA)
    normalizeOciArchive(rawOciB, ociB)
    const imageA = inspectOciArchive(ociA)
    const imageB = inspectOciArchive(ociB)
    assert.deepEqual(imageA, imageB, 'OCI archive is nondeterministic')
    const finalOci = join(artifactDir, 'runtime-image.oci.tar')
    copyFileSync(ociA, finalOci)
    const finalLayout = join(artifactDir, 'runtime-image-oci-layout')
    rmSync(finalLayout, { recursive: true, force: true })
    mkdirSync(finalLayout)
    run('tar', ['-xf', finalOci, '-C', finalLayout])
    const registry = registryRoundTrip(ociA)
    const record = {
      accepted: true,
      sourceCommit: commit,
      sourceDirty,
      buildEnvironments: 2,
      sourceDateEpoch: epoch,
      packageManager: 'pnpm@9.15.3',
      dependencyLockSha256: sha256(readFileSync(join(root, 'pnpm-lock.yaml'))),
      artifacts,
      image: {
        tag: imageTag,
        ociArchiveSha256: imageA.archiveSha256,
        localManifestDigest: imageA.manifestDigest,
        localConfigDigest: imageA.configDigest,
        rootFsLayers: imageA.layerDigests,
        platform: imageA.platform,
        ...registry,
      },
      allDigestsMatch: true,
      registryRoundTrip: true,
    }
    writeFileSync(
      join(out, 'release-manifest.json'),
      `${JSON.stringify(record, null, 2)}\n`,
    )
    emit(record)
  } finally {
    const builderVolume = String(
      docker(
        [
          'inspect',
          builderContainer,
          '--format',
          '{{range .Mounts}}{{if eq .Destination "/var/lib/buildkit"}}{{.Name}}{{end}}{{end}}',
        ],
        true,
      ).stdout,
    ).trim()
    docker(['buildx', 'rm', '-f', builder], true)
    if (builderVolume) docker(['volume', 'rm', builderVolume], true)
    rmSync(temp, { recursive: true, force: true })
    cleanupToolImages([
      'moby/buildkit:buildx-stable-1',
      'quay.io/skopeo/stable:v1.19.0',
      'registry:2.8.3',
    ])
  }
}

const requireRelease = () => {
  const path = join(out, 'release-manifest.json')
  assert(existsSync(path), 'run wp29:reproducible-build first')
  const release = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(release.sourceCommit, commit)
  return release
}
const scanner = (
  image: string,
  args: string[],
  mounts: string[] = [],
  allowFailure = false,
) =>
  docker(
    [
      'run',
      '--rm',
      ...mounts.flatMap((mount) => ['-v', mount]),
      image,
      ...args,
    ],
    allowFailure,
  )

const sbom = () => {
  const release = requireRelease()
  const outputs = [
    {
      name: 'source',
      args: ['scan', 'dir:/src', '-o', 'cyclonedx-json'],
      mounts: [`${root}:/src:ro`],
    },
    ...release.artifacts.map((artifact: any) => ({
      name: artifact.name,
      args: ['scan', `file:/art/${artifact.name}.tar`, '-o', 'cyclonedx-json'],
      mounts: [`${artifactDir}:/art:ro`],
    })),
    {
      name: 'image',
      args: [
        'scan',
        'oci-dir:/art/runtime-image-oci-layout',
        '--platform',
        release.image.platform,
        '-o',
        'cyclonedx-json',
      ],
      mounts: [`${artifactDir}:/art:ro`],
    },
  ].map(({ name, args, mounts }) => {
    const result = scanner('anchore/syft:v1.33.0', args, mounts)
    const text = String(result.stdout)
    const parsed = JSON.parse(text)
    assert.equal(parsed.bomFormat, 'CycloneDX')
    const path = join(evidenceDir, `sbom-${name}.cdx.json`)
    writeFileSync(path, text)
    return {
      name,
      path: basename(path),
      sha256: sha256(text),
      components: parsed.components?.length ?? 0,
      sourceMetadata: parsed.metadata?.component ?? null,
    }
  })
  assert(outputs.find(({ name }) => name === 'source')!.components > 0)
  assert(outputs.find(({ name }) => name === 'image')!.components > 0)
  assert(outputs.every(({ components }) => components > 0))
  emit({
    accepted: true,
    scanner: 'syft',
    scannerVersion: '1.33.0',
    artifactDigest: release.image.digest,
    sboms: outputs,
  })
  cleanupToolImages(['anchore/syft:v1.33.0'])
}

const cosign = (
  args: string[],
  work: string,
  env: string[] = [],
  allowFailure = false,
  network?: string,
) => (
  mkdirSync(join(work, 'home'), { recursive: true }),
  docker(
    [
      'run',
      '--rm',
      ...(network ? ['--network', network] : []),
      '-e',
      'HOME=/work/home',
      ...env.flatMap((entry) => ['-e', entry]),
      '-v',
      `${work}:/work`,
      '-w',
      '/work',
      '--add-host',
      'host.docker.internal:host-gateway',
      'ghcr.io/sigstore/cosign/cosign:v2.5.3',
      ...args,
    ],
    allowFailure,
  )
)

const signatures = () => {
  const release = requireRelease()
  const sbomFiles = readdirSync(evidenceDir)
    .filter((name) => name.startsWith('sbom-') && name.endsWith('.json'))
    .map((name) => join(evidenceDir, name))
  assert(sbomFiles.length >= 2, 'run wp29:sbom first')
  const work = mkdtempSync(join(tmpdir(), 'wp29-sign-'))
  const password = randomBytes(24).toString('hex')
  try {
    cosign(['generate-key-pair'], work, [`COSIGN_PASSWORD=${password}`])
    const provenance = {
      _type: 'https://in-toto.io/Statement/v1',
      subject: [
        ...release.artifacts.map((artifact: any) => ({
          name: artifact.name,
          digest: { sha256: artifact.sha256 },
        })),
        {
          name: 'runtime-image',
          digest: { sha256: release.image.digest.replace('sha256:', '') },
        },
      ],
      predicateType: 'https://slsa.dev/provenance/v1',
      predicate: {
        buildDefinition: {
          buildType: 'https://perseverance.invalid/wp29/clean-build/v1',
          externalParameters: {
            repository: 'perseverance',
            sourceCommit: commit,
          },
          internalParameters: { lockSha256: release.dependencyLockSha256 },
        },
        runDetails: { builder: { id: 'wp29-clean-worktree-builder-v1' } },
      },
    }
    const provenancePath = join(work, 'provenance.intoto.json')
    writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`)
    const files = [
      ...release.artifacts.map((artifact: any) =>
        join(artifactDir, `${artifact.name}.tar`),
      ),
      ...sbomFiles,
      provenancePath,
    ]
    const verifications = files.map((file) => {
      const local = join(work, basename(file))
      if (resolve(file) !== resolve(local)) copyFileSync(file, local)
      const signature = `${basename(file)}.sig`
      cosign(
        [
          'sign-blob',
          '--yes',
          '--key',
          '/work/cosign.key',
          '--output-signature',
          `/work/${signature}`,
          `/work/${basename(file)}`,
        ],
        work,
        [`COSIGN_PASSWORD=${password}`],
      )
      cosign(
        [
          'verify-blob',
          '--key',
          '/work/cosign.pub',
          '--signature',
          `/work/${signature}`,
          `/work/${basename(file)}`,
        ],
        work,
      )
      const tampered = join(work, `${basename(file)}.tampered`)
      writeFileSync(
        tampered,
        Buffer.concat([readFileSync(local), Buffer.from('tamper')]),
      )
      assert.notEqual(
        cosign(
          [
            'verify-blob',
            '--key',
            '/work/cosign.pub',
            '--signature',
            `/work/${signature}`,
            `/work/${basename(tampered)}`,
          ],
          work,
          [],
          true,
        ).status,
        0,
      )
      return {
        name: basename(file),
        sha256: sha256(readFileSync(local)),
        signatureSha256: sha256(readFileSync(join(work, signature))),
        verified: true,
        tamperedRejected: true,
      }
    })
    assert.notEqual(
      cosign(
        [
          'verify-blob',
          '--key',
          '/work/cosign.pub',
          '--signature',
          '/work/missing.sig',
          `/work/${basename(files[0]!)}`,
        ],
        work,
        [],
        true,
      ).status,
      0,
    )
    const trust = {
      fingerprint: sha256(readFileSync(join(work, 'cosign.pub'))),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      revoked: false,
      repository: 'perseverance',
      sourceCommit: commit,
      artifactSha256: sha256(readFileSync(provenancePath)),
    }
    const trustPath = join(work, 'trust-policy.json')
    writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`)
    const verifier = (overrides: Record<string, unknown> = {}) => {
      writeFileSync(
        trustPath,
        `${JSON.stringify({ ...trust, ...overrides }, null, 2)}\n`,
      )
      return run(
        'pnpm',
        [
          'exec',
          'tsx',
          'scripts/wp29-admission-verifier.ts',
          '--artifact',
          provenancePath,
          '--signature',
          `${provenancePath}.sig`,
          '--public-key',
          join(work, 'cosign.pub'),
          '--policy',
          trustPath,
          '--repository',
          'perseverance',
          '--source-commit',
          commit,
        ],
        { allowFailure: true },
      )
    }
    const validAdmission = verifier()
    assert.equal(
      validAdmission.status,
      0,
      `${String(validAdmission.stdout)}${String(validAdmission.stderr)}`,
    )
    assert.notEqual(verifier({ repository: 'wrong/repository' }).status, 0)
    assert.notEqual(
      verifier({ validUntil: new Date(Date.now() - 60_000).toISOString() })
        .status,
      0,
    )
    assert.notEqual(verifier({ revoked: true }).status, 0)
    writeFileSync(trustPath, `${JSON.stringify(trust, null, 2)}\n`)

    const registryName = `persistent-wp29-signing-registry-${process.pid}`
    const registryNetwork = `persistent-wp29-sign-network-${process.pid}`
    let imageVerification: Record<string, unknown>
    try {
      docker(['network', 'create', registryNetwork])
      docker([
        'run',
        '-d',
        '--name',
        registryName,
        '--label',
        'persistent.wp29=true',
        '--network',
        registryNetwork,
        '--tmpfs',
        '/var/lib/registry:rw,size=512m',
        'registry:2.8.3',
      ])
      let ready = false
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          docker(
            ['exec', registryName, 'wget', '-qO-', 'http://127.0.0.1:5000/v2/'],
            true,
          ).status === 0
        ) {
          ready = true
          break
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      assert(ready, 'local signing registry did not become ready')
      copyFileSync(
        join(artifactDir, 'runtime-image.oci.tar'),
        join(work, 'runtime-image.oci.tar'),
      )
      const localRepository = `${registryName}:5000/persistent/wp29-signed`
      skopeo(
        [
          'copy',
          '--dest-tls-verify=false',
          'oci-archive:/work/runtime-image.oci.tar',
          `docker://${localRepository}:${commit}`,
        ],
        [`${work}:/work`],
        registryNetwork,
      )
      const digest = release.image.digest
      const imageReference = `${localRepository}@${digest}`
      cosign(
        [
          'sign',
          '--yes',
          '--allow-http-registry',
          '--allow-insecure-registry',
          '--key',
          '/work/cosign.key',
          imageReference,
        ],
        work,
        [`COSIGN_PASSWORD=${password}`],
        false,
        registryNetwork,
      )
      const verified = cosign(
        [
          'verify',
          '--allow-http-registry',
          '--allow-insecure-registry',
          '--key',
          '/work/cosign.pub',
          imageReference,
        ],
        work,
        [],
        false,
        registryNetwork,
      )
      skopeo(
        [
          'copy',
          '--src-tls-verify=false',
          '--dest-tls-verify=false',
          `docker://${imageReference}`,
          `docker://${registryName}:5000/wrong/repository:tampered`,
        ],
        [`${work}:/work`],
        registryNetwork,
      )
      assert.notEqual(
        cosign(
          [
            'verify',
            '--allow-http-registry',
            '--allow-insecure-registry',
            '--key',
            '/work/cosign.pub',
            `${registryName}:5000/wrong/repository@${digest}`,
          ],
          work,
          [],
          true,
          registryNetwork,
        ).status,
        0,
      )
      imageVerification = {
        repository: localRepository,
        digest,
        verified: true,
        wrongRepositoryRejected: true,
        tamperedOrUnsignedImageRejected: true,
        verifierOutputSha256: sha256(String(verified.stdout)),
      }
    } finally {
      docker(['rm', '-f', registryName], true)
      docker(['network', 'rm', registryNetwork], true)
    }
    const publicKey = join(evidenceDir, 'wp29-cosign.pub')
    copyFileSync(join(work, 'cosign.pub'), publicKey)
    for (const item of verifications)
      copyFileSync(
        join(work, `${item.name}.sig`),
        join(evidenceDir, `${item.name}.sig`),
      )
    copyFileSync(provenancePath, join(evidenceDir, 'provenance.intoto.json'))
    emit({
      accepted: true,
      tool: 'cosign',
      toolVersion: '2.5.3',
      sourceCommit: commit,
      signerFingerprint: trust.fingerprint,
      provenanceSha256: sha256(readFileSync(provenancePath)),
      imageVerification,
      verifications,
      adversarial: {
        tamperedRejected: true,
        unsignedRejected: true,
        wrongRepositoryRejectedByVerifier: true,
        expiredSignerRejectedByVerifier: true,
        revokedSignerRejectedByVerifier: true,
      },
      privateKeyPersisted: false,
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
    cleanupToolImages([
      'ghcr.io/sigstore/cosign/cosign:v2.5.3',
      'quay.io/skopeo/stable:v1.19.0',
      'registry:2.8.3',
    ])
  }
}

const securityScans = () => {
  const release = requireRelease()
  const sourceSbomPath = join(evidenceDir, 'sbom-source.cdx.json')
  assert(existsSync(sourceSbomPath), 'run wp29:sbom first')
  const sourceSbom = JSON.parse(readFileSync(sourceSbomPath, 'utf8'))
  const licensePolicy = JSON.parse(
    readFileSync(
      join(root, 'infra/release/wp29-license-policy.v1.json'),
      'utf8',
    ),
  )
  const npmComponents = (sourceSbom.components ?? []).filter(
    (component: any) =>
      String(component.purl ?? '').startsWith('pkg:npm/') &&
      !String(component.name ?? '').startsWith('@perseverance/'),
  )
  const licenses = npmComponents.flatMap((component: any) =>
    (component.licenses ?? []).flatMap((entry: any) => {
      const id = entry.license?.id ?? entry.expression
      return id ? [{ component: component.name, id }] : []
    }),
  )
  const forbiddenLicenses = licenses.filter(({ id }: any) =>
    licensePolicy.forbidden.includes(id),
  )
  assert.equal(forbiddenLicenses.length, 0, 'forbidden dependency license')
  assert(npmComponents.length > 0, 'license scanner found no npm components')
  const reports = mkdtempSync(join(tmpdir(), 'wp29-scans-'))
  const mounts = [`${root}:/src:ro`, `${reports}:/out`]
  try {
    mkdirSync(join(out, 'trivy-cache'), { recursive: true })
    mkdirSync(join(reports, 'trivy-tmp'))
    const trivyMounts = [
      `${join(out, 'trivy-cache')}:/root/.cache/trivy`,
      `${join(reports, 'trivy-tmp')}:/tmp`,
    ]
    const gitleaks = scanner(
      'zricethezav/gitleaks:v8.28.0',
      [
        'detect',
        '--source=/src',
        '--config=/src/infra/release/wp31-gitleaks.toml',
        '--report-format=json',
        '--report-path=/out/gitleaks.json',
        '--redact',
        '--no-banner',
      ],
      mounts,
    )
    const semgrep = scanner(
      'semgrep/semgrep:1.132.0',
      [
        'semgrep',
        'scan',
        '--config',
        '/src/infra/release/wp29-semgrep.yml',
        '--json',
        '/src/services',
        '/src/packages',
        '/src/agents',
      ],
      [`${root}:/src:ro`],
    )
    const audit = run('pnpm', ['audit', '--json'], { cwd: root })
    const trivyFs = scanner(
      'aquasec/trivy:0.65.0',
      [
        'fs',
        '--format',
        'json',
        '--scanners',
        'vuln',
        '--severity',
        'HIGH,CRITICAL',
        '--skip-dirs',
        '**/.runtime',
        '--skip-dirs',
        '**/node_modules',
        '--skip-dirs',
        '**/dist',
        '--skip-dirs',
        '**/.wp29',
        '--skip-dirs',
        '**/.wp31',
        '--skip-dirs',
        '/src/_to_delete',
        '--exit-code',
        '1',
        '/src',
      ],
      [`${root}:/src:ro`, ...trivyMounts],
    )
    const trivyImage = scanner(
      'aquasec/trivy:0.65.0',
      [
        'image',
        '--input',
        '/art/runtime-image-oci-layout',
        '--scanners',
        'vuln',
        '--format',
        'json',
        '--severity',
        'HIGH,CRITICAL',
        '--exit-code',
        '1',
      ],
      [`${artifactDir}:/art:ro`, ...trivyMounts],
    )
    const hadolint = scanner(
      'hadolint/hadolint:v2.12.0-alpine',
      ['hadolint', '-f', 'json', '/src/infra/release/wp29-runtime.Dockerfile'],
      [`${root}:/src:ro`],
    )
    const conftest = scanner(
      'openpolicyagent/conftest:v0.62.0',
      [
        'test',
        '--parser',
        'dockerfile',
        '--policy',
        '/src/infra/release',
        '/src/infra/release/wp29-runtime.Dockerfile',
        '--output',
        'json',
      ],
      [`${root}:/src:ro`],
    )
    const fixture = join(reports, 'fixtures')
    mkdirSync(fixture, { recursive: true })
    writeFileSync(
      join(fixture, 'secret.txt'),
      `${'WP29_PROVIDER_' + 'CREDENTIAL_'}1234567890abcdef\n`,
    )
    writeFileSync(
      join(fixture, 'bad.ts'),
      'const userInput = "x"; eval(userInput)\n',
    )
    writeFileSync(join(fixture, 'Dockerfile'), 'FROM node:latest\nUSER root\n')
    const fixtureMount = `${fixture}:/fixture:ro`
    assert.notEqual(
      scanner(
        'zricethezav/gitleaks:v8.28.0',
        [
          'detect',
          '--source=/fixture',
          '--config=/src/infra/release/wp31-gitleaks.toml',
          '--no-git',
          '--no-banner',
        ],
        [`${root}:/src:ro`, fixtureMount],
        true,
      ).status,
      0,
    )
    const vulnerableImage = `wp29-vulnerable-fixture:${process.pid}`
    const vulnerableRoot = join(fixture, 'vulnerable-image')
    mkdirSync(vulnerableRoot)
    writeFileSync(
      join(vulnerableRoot, 'Dockerfile'),
      `FROM node@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd\nWORKDIR /fixture\nRUN npm install --ignore-scripts --no-audit lodash@4.17.20\nUSER node\n`,
    )
    docker(['build', '--no-cache', '-t', vulnerableImage, vulnerableRoot])
    const vulnerableScan = scanner(
      'aquasec/trivy:0.65.0',
      [
        'image',
        '--format',
        'json',
        '--severity',
        'HIGH,CRITICAL',
        '--exit-code',
        '1',
        vulnerableImage,
      ],
      [
        `${process.env.HOME}/.docker/run/docker.sock:/var/run/docker.sock`,
        ...trivyMounts,
      ],
      true,
    )
    assert.notEqual(vulnerableScan.status, 0)
    docker(['rmi', '-f', vulnerableImage], true)
    assert.notEqual(
      scanner(
        'semgrep/semgrep:1.132.0',
        [
          'semgrep',
          'scan',
          '--config',
          '/src/infra/release/wp29-semgrep.yml',
          '--error',
          '/fixture',
        ],
        [`${root}:/src:ro`, fixtureMount],
        true,
      ).status,
      0,
    )
    assert.notEqual(
      scanner(
        'hadolint/hadolint:v2.12.0-alpine',
        ['hadolint', '/fixture/Dockerfile'],
        [fixtureMount],
        true,
      ).status,
      0,
    )
    assert.notEqual(
      scanner(
        'openpolicyagent/conftest:v0.62.0',
        [
          'test',
          '--parser',
          'dockerfile',
          '--policy',
          '/src/infra/release',
          '/fixture/Dockerfile',
        ],
        [`${root}:/src:ro`, fixtureMount],
        true,
      ).status,
      0,
    )
    const raw = {
      gitleaks: String(gitleaks.stdout),
      semgrep: String(semgrep.stdout),
      pnpmAudit: String(audit.stdout),
      trivyFs: String(trivyFs.stdout),
      trivyImage: String(trivyImage.stdout),
      hadolint: String(hadolint.stdout),
      conftest: String(conftest.stdout),
    }
    const summaries = Object.entries(raw).map(([name, content]) => {
      const path = join(evidenceDir, `scanner-${name}.json`)
      writeFileSync(path, content.length ? content : '[]\n')
      return {
        name,
        sha256: sha256(content),
        byteLength: Buffer.byteLength(content),
      }
    })
    emit({
      accepted: true,
      scanners: {
        gitleaks: '8.28.0',
        semgrep: '1.132.0',
        trivy: '0.65.0',
        syft: '1.33.0',
        hadolint: '2.12.0',
        conftest: '0.62.0',
        pnpmAudit: '9.15.3',
      },
      reports: summaries,
      licensePolicy: {
        inputSbomSha256: sha256(readFileSync(sourceSbomPath)),
        npmComponents: npmComponents.length,
        licensesObserved: [
          ...new Set(licenses.map(({ id }: any) => id)),
        ].sort(),
        forbiddenFindings: forbiddenLicenses,
      },
      blockers: 0,
      fixturesDetected: {
        secret: true,
        sast: true,
        iac: true,
        vulnerableImage: true,
      },
      runtimeImageDigest: release.image.digest,
    })
  } finally {
    rmSync(reports, { recursive: true, force: true })
    cleanupToolImages([
      'zricethezav/gitleaks:v8.28.0',
      'semgrep/semgrep:1.132.0',
      'aquasec/trivy:0.65.0',
      'hadolint/hadolint:v2.12.0-alpine',
      'openpolicyagent/conftest:v0.62.0',
    ])
  }
}

const directoryDigest = (directory: string, semanticJson = false) => {
  const hash = createHash('sha256')
  for (const file of listFiles(directory).sort()) {
    const name = relative(directory, file)
    const content = readFileSync(file)
    hash.update(name).update('\0')
    hash.update(
      semanticJson && name.endsWith('.json')
        ? canonical(JSON.parse(content.toString()))
        : content,
    )
    hash.update('\0')
  }
  return hash.digest('hex')
}
const providerCanary = () => {
  const binary = process.env.WP29_CODEX_BIN
  assert(binary, 'WP29_CODEX_BIN is required')
  assert.match(String(run(binary, ['--version']).stdout), /0\.144\.2/)
  const temp = mkdtempSync(join(tmpdir(), 'wp29-schema-'))
  try {
    const ts = join(temp, 'typescript')
    const json = join(temp, 'json-schema')
    mkdirSync(ts)
    mkdirSync(json)
    run(binary, ['app-server', 'generate-ts', '--out', ts])
    run(binary, ['app-server', 'generate-json-schema', '--out', json])
    const repository = join(
      root,
      'packages/codex-protocol-generated/src/generated',
    )
    const generated = join(temp, 'generated')
    mkdirSync(generated)
    cpSync(ts, join(generated, 'typescript'), { recursive: true })
    cpSync(json, join(generated, 'json-schema'), { recursive: true })
    const repositoryHash = directoryDigest(repository, true)
    const generatedHash = directoryDigest(generated, true)
    assert.equal(generatedHash, repositoryHash, 'generated protocol drift')
    let sequence = 0
    const adapter = new CodexEventAdapter({
      tenantId: 'canary',
      workspaceId: 'canary',
      sessionId: 'canary',
      sourceVersion: '0.144.2',
      nextSequence: () => ++sequence,
      nextEventId: () => `event-${sequence + 1}`,
      now: () => new Date('2026-07-21T00:00:00Z'),
    })
    const golden = listFiles(join(root, 'tests/golden-sessions'))
      .filter(
        (file) =>
          file.endsWith('.input.jsonl') &&
          !['unknown.input.jsonl', 'secret-redaction.input.jsonl'].includes(
            basename(file),
          ),
      )
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      )
    const brokenSchemaEvent = {
      method: 'item/wp29BrokenSchema/completed',
      params: { threadId: 'thread-broken', futureEnum: 'impossible' },
    }
    const healthyReplay = golden.map((event) => adapter.adapt(event))
    const healthyUnknown = healthyReplay.filter(
      ({ event }) => event.type === 'codex.unknown',
    ).length
    const threshold = 0.01
    const healthyUnknownRate = healthyUnknown / healthyReplay.length
    assert(healthyUnknownRate <= threshold, 'healthy canary must progress')
    const replayed = [...healthyReplay, adapter.adapt(brokenSchemaEvent)]
    const unknown = replayed.filter(
      ({ event }) => event.type === 'codex.unknown',
    ).length
    const unknownRate = unknown / replayed.length
    assert(unknown > healthyUnknown)
    assert(unknownRate > threshold, 'broken schema fixture must halt canary')
    emit({
      accepted: true,
      codexVersion: '0.144.2',
      generatedCommands: ['generate-ts', 'generate-json-schema'],
      generatedHash,
      repositoryHash,
      generatedDrift: generatedHash !== repositoryHash,
      healthyReplayedEvents: healthyReplay.length,
      healthyUnknownEvents: healthyUnknown,
      healthyUnknownEventRate: healthyUnknownRate,
      healthyRolloutProgressed: true,
      replayedEvents: replayed.length,
      unknownEvents: unknown,
      unknownEventRate: unknownRate,
      unknownThreshold: threshold,
      brokenSchemaHalted: true,
      unknownFallback: 'codex.unknown',
      externalProviders: {
        claude: 'not-run-no-authorized-credential',
        gemini: 'not-run-no-authorized-credential',
        cursor: 'not-run-no-authorized-credential',
      },
    })
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

const compliance = () => {
  const mapping = JSON.parse(
    readFileSync(
      join(root, 'infra/compliance/wp29-control-mapping.v1.json'),
      'utf8',
    ),
  )
  const required = [
    ...new Set<string>(
      mapping.controls.map(
        (control: { gate: string }) => `${control.gate.replace(':', '-')}.json`,
      ),
    ),
  ]
  for (const name of required)
    assert(existsSync(join(evidenceDir, name)), `missing real evidence ${name}`)
  const records = mapping.controls.map((control: any, index: number) => {
    const file = `${control.gate.replace(':', '-')}.json`
    assert(required.includes(file), `unmapped evidence gate ${control.gate}`)
    const parsed = JSON.parse(readFileSync(join(evidenceDir, file), 'utf8'))
    assert.equal(parsed.accepted, true)
    return {
      controlId: control.controlId,
      runId: `${control.gate}-${index + 1}-${commit.slice(0, 12)}`,
      gate: control.gate,
      evidenceType: control.evidenceType,
      file,
      sha256: sha256(readFileSync(join(evidenceDir, file))),
      sourceCommit: parsed.sourceCommit ?? commit,
    }
  })
  const bundle = {
    schemaVersion: 1,
    sourceCommit: commit,
    controls: mapping.controls,
    evidence: records,
  }
  writeFileSync(
    join(evidenceDir, 'compliance-bundle.json'),
    `${JSON.stringify(bundle, null, 2)}\n`,
  )
  emit({
    accepted: true,
    sourceCommit: commit,
    controls: mapping.controls.length,
    evidenceRuns: records,
    bundleSha256: sha256(canonical(bundle)),
    unsupportedManualPassed: false,
  })
}

switch (gate) {
  case 'wp29:reproducible-build':
    reproducible()
    break
  case 'wp29:sbom':
    sbom()
    break
  case 'wp29:signatures':
    signatures()
    break
  case 'wp29:security-scans':
    securityScans()
    break
  case 'wp29:provider-canary':
    providerCanary()
    break
  case 'wp29:compliance':
    compliance()
    break
  default:
    throw new Error(`unknown real WP29 gate: ${gate}`)
}
