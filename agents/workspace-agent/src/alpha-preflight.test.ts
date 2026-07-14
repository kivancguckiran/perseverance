import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AlphaPreflightError,
  runAlphaPreflight,
  validateProvisioningSource,
} from './alpha-preflight'

describe('alpha preflight', () => {
  it('rejects a provisioning symlink escape without reading credential content', () => {
    const root = mkdtempSync(join(tmpdir(), 'alpha-preflight-'))
    const source = join(root, 'source')
    mkdirSync(source)
    writeFileSync(join(root, 'outside'), 'fixture-secret-never-read')
    symlinkSync(join(root, 'outside'), join(source, 'auth.json'))
    expect(() => validateProvisioningSource(source)).toThrowError(
      AlphaPreflightError,
    )
    rmSync(root, { recursive: true, force: true })
  })

  it('reports version and unwritable path failures deterministically', () => {
    const root = mkdtempSync(join(tmpdir(), 'alpha-preflight-'))
    const bin = join(root, 'codex')
    writeFileSync(bin, '#!/bin/sh\necho codex-cli 9.9.9\n', { mode: 0o700 })
    const workspace = join(root, 'workspace')
    mkdirSync(workspace)
    const checks = runAlphaPreflight({
      codexBin: bin,
      workspaceCwd: workspace,
      databasePath: join(root, 'db', 'events.sqlite'),
      artifactRoot: join(root, 'artifacts'),
      codexHomeRoot: join(root, 'homes'),
    })
    expect(checks.find((check) => check.name === 'codex')).toMatchObject({
      status: 'failed',
      code: 'CODEX_VERSION_MISMATCH',
    })
    expect(checks.filter((check) => check.status === 'ready')).toHaveLength(4)
    chmodSync(root, 0o700)
    rmSync(root, { recursive: true, force: true })
  })

  it('classifies missing and non-file provisioning targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'alpha-preflight-'))
    expect(() =>
      validateProvisioningSource(join(root, 'missing')),
    ).toThrowError('PROVISIONING_SOURCE_MISSING')
    const empty = join(root, 'empty')
    mkdirSync(empty)
    expect(() => validateProvisioningSource(empty)).toThrowError(
      'AUTH_CONFIG_MISSING',
    )
    mkdirSync(join(empty, 'auth.json'))
    expect(() => validateProvisioningSource(empty)).toThrowError(
      'PROVISIONING_TARGET_NOT_FILE',
    )
    rmSync(root, { recursive: true, force: true })
  })

  it('rejects parent symlinks and read-only runtime roots', () => {
    const root = mkdtempSync(join(tmpdir(), 'alpha-preflight-'))
    const real = join(root, 'real')
    mkdirSync(real)
    const linked = join(root, 'linked')
    symlinkSync(real, linked)
    const bin = join(root, 'codex')
    writeFileSync(bin, '#!/bin/sh\necho codex-cli 0.144.2\n', { mode: 0o700 })
    const readonly = join(root, 'readonly')
    mkdirSync(readonly, { mode: 0o500 })
    const checks = runAlphaPreflight({
      codexBin: bin,
      workspaceCwd: readonly,
      databasePath: join(linked, 'events.sqlite'),
      artifactRoot: join(root, 'artifacts'),
      codexHomeRoot: join(root, 'homes'),
    })
    expect(checks.find((check) => check.name === 'workspace')?.code).toBe(
      'PATH_NOT_WRITABLE',
    )
    expect(checks.find((check) => check.name === 'database')?.code).toBe(
      'PATH_SYMLINK_COMPONENT',
    )
    chmodSync(readonly, 0o700)
    rmSync(root, { recursive: true, force: true })
  })
})
