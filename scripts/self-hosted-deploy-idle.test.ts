import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  scanForCredentials,
  selfHostedStaticScanPolicy,
} from './self-hosted-release'

const root = resolve(import.meta.dirname, '..')
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('self-hosted deploy idle gate', () => {
  const submitter = read('scripts/deploy-self-hosted.sh')
  const worker = read('scripts/run-pending-self-hosted-deploy.sh')

  it('keeps both shell entrypoints syntactically valid', () => {
    for (const path of [
      'scripts/deploy-self-hosted.sh',
      'scripts/run-pending-self-hosted-deploy.sh',
    ])
      execFileSync('bash', ['-n', resolve(root, path)])
  })

  it('defaults to a one-hour idle window and validates operator overrides', () => {
    expect(submitter).toContain('PERSISTENT_DEPLOY_IDLE_SECONDS:-3600')
    expect(submitter).toContain('IDLE_SECONDS >= 60')
    expect(submitter).toContain('IDLE_SECONDS <= 604800')
    expect(submitter).toContain('PERSISTENT_DEPLOY_POLL_SECONDS:-60')
    expect(submitter).toContain('POLL_SECONDS >= 5')
    expect(submitter).toContain('POLL_SECONDS <= 3600')
  })

  it('canonicalizes host paths and rejects traversal and kernel filesystems', () => {
    for (const script of [submitter, worker]) {
      expect(script).toContain('canonical_host_path()')
      expect(script).toContain("host path '..' içeremez")
      expect(script).toContain('/proc | /proc/* | /sys | /sys/*')
      expect(script).toContain('host path symlink veya canonical olmayan')
    }
  })

  it('submits atomic pending state and detaches the same-host worker', () => {
    expect(submitter).toContain('pending-remote-deploy.env')
    expect(submitter).toContain('mv "${pending_tmp}" "${pending_file}"')
    expect(submitter).toContain('nohup bash "${worker_script}"')
    expect(submitter).not.toContain('PERSISTENT_DEPLOY_SSH')
    expect(submitter).not.toContain('SSH_COMMAND')
    expect(submitter).not.toContain('tailscale')
    expect(submitter).not.toContain(
      'bash infra/self-hosted/self-hosted.sh upgrade',
    )
  })

  it('uses durable product activity and blocks while work is executing', () => {
    expect(worker).toContain('persistent_codex.ha_events')
    expect(worker).toContain('persistent_codex.ha_runs')
    expect(worker).toContain('persistent_codex.scheduler_queue')
    expect(worker).toContain(
      "state IN ('queued','leased','starting','running')",
    )
    expect(worker).toContain('activity_age < idle_seconds')
    expect(worker).toContain('confirmed_activity_age < idle_seconds')
    expect(worker).toContain('latest_pending_sha')
    expect(worker).not.toMatch(/caddy.*access|access.*log/i)
  })

  it('serializes workers and preserves the canonical release gates', () => {
    expect(worker).toContain('remote-deploy-worker.lock')
    expect(worker).toContain('mkdir "${worker_lock}"')
    expect(worker).toContain('bash infra/self-hosted/self-hosted.sh upgrade')
    expect(worker).toContain("-name 'backup-*.tar.enc'")
    expect(worker).toContain('label=persistent.self-hosted=true')
    expect(worker).toContain('"${container_count}" -ge 9')
    expect(worker).toContain('/readyz')
    expect(worker).toContain('"ready"[[:space:]]*:[[:space:]]*true')
  })

  it('never sources pending state as shell code', () => {
    expect(worker).toContain('read_value()')
    expect(worker).not.toMatch(/source\s+"?\$\{?pending_file/)
  })

  it('contains no plaintext deployment credential', () => {
    expect(
      scanForCredentials(
        [
          { name: 'deploy-self-hosted.sh', content: submitter },
          { name: 'run-pending-self-hosted-deploy.sh', content: worker },
        ],
        selfHostedStaticScanPolicy,
      ),
    ).toEqual([])
  })
})
