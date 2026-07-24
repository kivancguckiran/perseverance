import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CodexEventAdapter } from '@persistent-codex/codex-event-adapter'
import {
  DEPLOYMENT_PROFILES,
  type DeploymentProfile,
  assertCoreSemanticsEntitled,
  assertEntitled,
} from './index'

// Fork-engelleyici contract testi (ADR-0033): aynı golden event/conversation
// akışı üç deployment profilinin composition'ından geçtiğinde bayt-eşdeğer
// çıktı üretmek zorundadır. Profil parametresinin event pipeline'ına sızması
// bu testi kırar.

const goldenDirectory = fileURLToPath(
  new URL('../../../tests/golden-sessions/', import.meta.url),
)

const fixtureNames = readdirSync(goldenDirectory)
  .filter((name) => name.endsWith('.input.jsonl'))
  .map((name) => name.replace('.input.jsonl', ''))
  .sort()

function loadInputs(name: string): unknown[] {
  return readFileSync(`${goldenDirectory}/${name}.input.jsonl`, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

// Control-plane composition'ının profil başına yaptığı gibi adapter kurar.
// Profil yalnız entitlement doğrulamasında görülür; event pipeline'ı profil
// parametresi almaz — contract tam olarak budur.
function profileScopedAdapter(profile: DeploymentProfile) {
  for (const feature of [
    'core.conversations',
    'core.events',
    'core.replay',
  ] as const) {
    assertEntitled(profile, feature)
  }
  let sequence = 0
  return new CodexEventAdapter({
    tenantId: 'ten_profile_contract',
    workspaceId: 'wsp_profile_contract',
    sessionId: 'ses_profile_contract',
    sourceVersion: '0.144.2',
    nextSequence: () => ++sequence,
    nextEventId: () => `evt_${String(sequence + 1).padStart(3, '0')}`,
    now: () => new Date('2026-07-14T00:00:00.000Z'),
  })
}

function contractDigest(profile: DeploymentProfile, name: string) {
  const adapter = profileScopedAdapter(profile)
  const results = loadInputs(name).map((input) => adapter.adapt(input))
  const serialized = JSON.stringify(results.map(({ event }) => event))
  return {
    sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
    serialized,
  }
}

describe('deployment profilleri arasında golden akış eşdeğerliği', () => {
  it('çekirdek semantik entitlement üç profilde de açıktır', () => {
    expect(() => assertCoreSemanticsEntitled()).not.toThrow()
  })

  it.each(fixtureNames)(
    '%s golden akışı üç profilde bayt-eşdeğer contract çıktısı üretir',
    (name) => {
      const [local, selfHosted, cloud] = DEPLOYMENT_PROFILES.map((profile) =>
        contractDigest(profile, name),
      )
      expect(local!.serialized).toBe(selfHosted!.serialized)
      expect(selfHosted!.serialized).toBe(cloud!.serialized)
      expect(local!.sha256).toBe(cloud!.sha256)
    },
  )
})
