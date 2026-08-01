import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { UsageReport } from '@perseverance/provider-platform'

export interface CodexTitleProcessInput {
  binary: string
  args: string[]
  codexHome: string
  cwd?: string
  requestId: string
}

export class CodexTitleProcessRunner {
  private readonly limits: {
    timeoutMs: number
    maxStdoutBytes: number
    maxStdoutLines: number
    killGraceMs: number
  }

  constructor(
    limits = {
      timeoutMs: 60_000,
      maxStdoutBytes: 1_048_576,
      maxStdoutLines: 10_000,
      killGraceMs: 1_000,
    },
  ) {
    this.limits = limits
  }

  async run(
    input: CodexTitleProcessInput,
  ): Promise<{ title: string; usage?: UsageReport }> {
    return await new Promise((resolve, reject) => {
      const child = spawn(input.binary, input.args, {
        cwd: input.cwd ?? tmpdir(),
        env: {
          CODEX_HOME: input.codexHome,
          HOME: process.env.HOME ?? '/home/workspace',
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          ...(process.env.SSL_CERT_FILE
            ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE }
            : {}),
        },
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let settled = false
      let bytes = 0
      let lineCount = 0
      let title = ''
      let usage: UsageReport | undefined
      let forceKill: NodeJS.Timeout | undefined
      const lines = createInterface({
        input: child.stdout,
        crlfDelay: Infinity,
      })
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        lines.close()
        child.removeAllListeners()
        if (error) reject(error)
        else resolve({ title: title.trim(), ...(usage ? { usage } : {}) })
      }
      const stop = (error: Error) => {
        if (settled) return
        child.kill('SIGTERM')
        forceKill = setTimeout(
          () => child.kill('SIGKILL'),
          this.limits.killGraceMs,
        )
        forceKill.unref()
        finish(error)
      }
      const timeout = setTimeout(
        () => stop(new Error('Codex title process timed out')),
        this.limits.timeoutMs,
      )
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > this.limits.maxStdoutBytes)
          stop(new Error('Codex title stdout byte limit exceeded'))
      })
      lines.on('line', (line) => {
        lineCount += 1
        if (lineCount > this.limits.maxStdoutLines) {
          stop(new Error('Codex title stdout line limit exceeded'))
          return
        }
        try {
          const event = JSON.parse(line) as Record<string, any>
          if (
            event.type === 'item.completed' &&
            event.item?.type === 'agent_message' &&
            typeof event.item.text === 'string'
          )
            title = event.item.text
          if (event.type === 'turn.completed' && event.usage)
            usage = {
              schemaVersion: 1,
              kind: 'cumulative',
              provider: 'codex',
              requestId: input.requestId,
              dedupeKey: `${input.requestId}:v1`,
              counters: {
                inputTokens: Number(event.usage.input_tokens ?? 0),
                cachedInputTokens: Number(event.usage.cached_input_tokens ?? 0),
                outputTokens: Number(event.usage.output_tokens ?? 0),
                reasoningTokens: Number(
                  event.usage.reasoning_output_tokens ?? 0,
                ),
                toolUnits: 0,
              },
              completeness: 'complete',
              occurredAt: new Date().toISOString(),
            }
        } catch {
          /* non-JSON output is ignored */
        }
      })
      child.once('error', (error) => finish(error))
      child.once('exit', (code) => {
        if (code !== 0) finish(new Error('Codex title process failed'))
        else if (!title.trim())
          finish(new Error('Codex title output was empty'))
        else finish()
      })
    })
  }
}
