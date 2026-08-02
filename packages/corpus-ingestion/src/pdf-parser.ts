import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorpusError } from './index'

export const PDF_PARSER_VERSION = 'poppler-pdftotext-v1'

export interface PdfParserLimits {
  maxBytes: number
  maxPdfPages: number
  parserTimeoutMs: number
  maxOutputBytes: number
  maxMemoryBytes: number
}

type CommandResult = {
  stdout: Buffer
  stderr: Buffer
  exitCode: number | null
}

function command(
  executable: string,
  args: string[],
  limits: Pick<
    PdfParserLimits,
    'parserTimeoutMs' | 'maxOutputBytes' | 'maxMemoryBytes'
  >,
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const productionLinux = process.platform === 'linux'
    const child = spawn(
      productionLinux ? 'prlimit' : executable,
      productionLinux
        ? [`--as=${limits.maxMemoryBytes}`, '--', executable, ...args]
        : args,
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    )
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let settled = false
    const finishError = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      reject(error)
    }
    const timer = setTimeout(() => {
      finishError(
        new CorpusError(
          'PARSER_TIMEOUT',
          'PDF parser timed out and was killed',
        ),
      )
    }, limits.parserTimeoutMs)
    timer.unref()
    const collect = (target: Buffer[]) => (part: Buffer) => {
      outputBytes += part.length
      if (outputBytes > limits.maxOutputBytes)
        finishError(
          new CorpusError(
            'PDF_OUTPUT_LIMIT',
            'PDF parser exceeded configured output limit',
          ),
        )
      else target.push(part)
    }
    child.stdout.on('data', collect(stdout))
    child.stderr.on('data', collect(stderr))
    child.once('error', () => {
      finishError(
        new CorpusError('PDF_PARSER_UNAVAILABLE', 'PDF parser is unavailable'),
      )
    })
    child.once('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        exitCode,
      })
    })
  })
}

function typedPdfFailure(result: CommandResult): CorpusError {
  const diagnostic = result.stderr.toString('utf8').toLowerCase()
  if (result.exitCode === 126 || result.exitCode === 127)
    return new CorpusError(
      'PDF_PARSER_UNAVAILABLE',
      'PDF parser is unavailable',
    )
  if (
    diagnostic.includes('incorrect password') ||
    diagnostic.includes('encrypted')
  )
    return new CorpusError(
      'PDF_PASSWORD_PROTECTED',
      'Password-protected PDF is not supported',
    )
  return new CorpusError('MALFORMED_PDF', 'PDF parser rejected the document')
}

export async function extractPdfInSandbox(input: {
  bytes: Uint8Array
  limits: PdfParserLimits
}): Promise<Array<{ text: string; page: number }>> {
  if (input.bytes.byteLength > input.limits.maxBytes)
    throw new CorpusError(
      'SOURCE_TOO_LARGE',
      'Source exceeds configured byte limit',
    )
  const root = mkdtempSync(join(tmpdir(), 'fixture-pdf-'))
  const sourcePath = join(root, 'source.pdf')
  try {
    writeFileSync(sourcePath, input.bytes, { flag: 'wx', mode: 0o600 })
    const info = await command('pdfinfo', [sourcePath], input.limits)
    if (info.exitCode !== 0) throw typedPdfFailure(info)
    const infoText = info.stdout.toString('utf8')
    const encrypted = /^Encrypted:\s+yes/im.test(infoText)
    if (encrypted)
      throw new CorpusError(
        'PDF_PASSWORD_PROTECTED',
        'Password-protected PDF is not supported',
      )
    const pages = Number.parseInt(
      /^Pages:\s+(\d+)/im.exec(infoText)?.[1] ?? '0',
      10,
    )
    if (!Number.isSafeInteger(pages) || pages < 1)
      throw new CorpusError('MALFORMED_PDF', 'PDF page metadata is invalid')
    if (pages > input.limits.maxPdfPages)
      throw new CorpusError(
        'PDF_PAGE_LIMIT',
        'PDF exceeds configured page limit',
      )
    const extracted: Array<{ text: string; page: number }> = []
    let extractedBytes = 0
    for (let page = 1; page <= pages; page++) {
      const result = await command(
        'pdftotext',
        [
          '-f',
          String(page),
          '-l',
          String(page),
          '-enc',
          'UTF-8',
          sourcePath,
          '-',
        ],
        input.limits,
      )
      if (result.exitCode !== 0) throw typedPdfFailure(result)
      extractedBytes += result.stdout.byteLength
      if (extractedBytes > input.limits.maxOutputBytes)
        throw new CorpusError(
          'PDF_OUTPUT_LIMIT',
          'PDF parser exceeded configured total output limit',
        )
      const text = result.stdout.toString('utf8').replace(/\f+$/g, '').trim()
      if (text) extracted.push({ text, page })
    }
    if (extracted.length === 0)
      throw new CorpusError(
        'OCR_REQUIRED',
        'PDF has no text layer; OCR is required',
      )
    return extracted
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
