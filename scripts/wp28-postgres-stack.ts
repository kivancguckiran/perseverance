import { randomUUID, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { Pool } from 'pg'

export class Wp28PostgresStack {
  readonly name = `persistent-wp28-db-${randomUUID()}`
  port = 0
  admin!: Pool
  runtime!: Pool
  docker(args: string[], allow = false) {
    const r = spawnSync('docker', args, { encoding: 'utf8' })
    if (!allow && r.status !== 0) throw new Error(r.stderr || r.stdout)
    return r.stdout.trim()
  }
  async start() {
    this.docker([
      'run',
      '-d',
      '--name',
      this.name,
      '--label',
      'persistent.wp28=true',
      '--tmpfs',
      '/var/lib/postgresql/data',
      '-e',
      'POSTGRES_PASSWORD=postgres',
      '-p',
      '127.0.0.1::5432',
      'postgres:17.5-alpine',
    ])
    let ready = false
    for (let i = 0; i < 120; i++) {
      if (
        spawnSync('docker', ['exec', this.name, 'pg_isready', '-U', 'postgres'])
          .status === 0
      ) {
        ready = true
        break
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!ready) throw new Error('WP28_POSTGRES_NOT_READY')
    // pg_isready can succeed during the final initdb restart; wait for the
    // long-lived postmaster before opening the migration connection.
    await new Promise((r) => setTimeout(r, 750))
    this.port = Number(
      this.docker(['port', this.name, '5432/tcp']).split(':').at(-1),
    )
    this.admin = new Pool({
      connectionString: `postgresql://postgres:postgres@127.0.0.1:${this.port}/postgres`,
    })
    for (const migration of [
      '0031_wp28_enterprise_lifecycle.sql',
      '0032_wp28_durable_enterprise_lifecycle.sql',
    ])
      await this.admin.query(
        readFileSync(`infra/postgres/migrations/${migration}`, 'utf8'),
      )
    await this.admin.query(
      `CREATE ROLE wp28_runtime LOGIN PASSWORD 'runtime' NOSUPERUSER NOBYPASSRLS;GRANT USAGE ON SCHEMA persistent_codex TO wp28_runtime;GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA persistent_codex TO wp28_runtime;`,
    )
    this.runtime = new Pool({
      connectionString: `postgresql://wp28_runtime:runtime@127.0.0.1:${this.port}/postgres`,
    })
  }
  async seedCredential(
    tenantId: string,
    organizationId: string,
    providerId: string,
    bearer: string,
  ) {
    await this.admin.query(
      `INSERT INTO persistent_codex.scim_credentials VALUES($1,$2,$3,$4,true,1,now(),null)`,
      [
        tenantId,
        organizationId,
        providerId,
        createHash('sha256').update(bearer).digest('hex'),
      ],
    )
  }
  async cleanup() {
    await this.runtime?.end()
    await this.admin?.end()
    this.docker(['rm', '-f', '-v', this.name], true)
  }
}
