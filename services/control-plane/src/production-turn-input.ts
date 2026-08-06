import {
  attachmentContextEnd,
  attachmentContextStart,
  productionTurnInputEnvelopeSchema,
  type ProductionTurnAttachment,
  type ProductionTurnInputEnvelope,
} from '@perseverance/control-plane-contracts'

export function decodeProductionTurnInput(
  value: string,
): ProductionTurnInputEnvelope {
  try {
    const parsed = productionTurnInputEnvelopeSchema.safeParse(
      JSON.parse(value),
    )
    if (parsed.success) return parsed.data
  } catch {
    // Legacy production runs stored the prompt as plain text.
  }
  return { schemaVersion: 1, prompt: value, attachments: [] }
}

export interface MaterializedProductionAttachment extends ProductionTurnAttachment {
  path: string
}

const archiveMediaTypes = new Set([
  'application/gzip',
  'application/vnd.rar',
  'application/x-7z-compressed',
  'application/x-bzip2',
  'application/x-rar-compressed',
  'application/x-tar',
  'application/zip',
])

const archiveNamePattern = /\.(?:7z|bz2|gz|rar|tar|tar\.bz2|tar\.gz|tgz|zip)$/i

export const archiveInstallGuidance =
  "Archive installation rule: If the user explicitly asks to install, apply, update, merge, import, or extract an attached archive into the current workspace, existing files and colliding paths are an update target, not by themselves a reason to stop. Validate archive entries first and reject absolute paths, parent traversal, and symlink or hardlink escapes. Compare collisions, make a recoverable backup of differing destination files below .perseverance/archive-backups/, overwrite package-owned collisions, preserve unrelated destination-only files, and continue with the package's validation or doctor commands. Do not replace .git or delete unrelated user files unless the user explicitly requests a full replacement; use the normal approval flow for actions that require approval."

export function isArchiveAttachment(attachment: {
  name: string
  mediaType: string
}): boolean {
  const mediaType = attachment.mediaType.toLowerCase().split(';', 1)[0]?.trim()
  return (
    archiveMediaTypes.has(mediaType ?? '') ||
    archiveNamePattern.test(attachment.name)
  )
}

export function productionAttachmentObjectKeys(input: {
  tenantId: string
  organizationId: string
  workspaceId: string
  sessionId: string
  attachmentId: string
}) {
  const base = `${input.tenantId}/${input.organizationId}/${input.workspaceId}/sessions/${input.sessionId}/attachments/${input.attachmentId}`
  return { data: `${base}/data`, metadata: `${base}/metadata` }
}

export function productionPromptWithAttachmentContext(
  prompt: string,
  attachments: MaterializedProductionAttachment[],
): string {
  const files = attachments.filter((attachment) => attachment.kind === 'file')
  if (files.length === 0) return prompt
  const context = [
    attachmentContextStart,
    'The following local files are attached to this message. Open and inspect them using their exact paths when answering:',
    ...files.map(
      (file) => `- ${JSON.stringify(file.name)}: ${JSON.stringify(file.path)}`,
    ),
    ...(files.some(isArchiveAttachment) ? [archiveInstallGuidance] : []),
    attachmentContextEnd,
  ].join('\n')
  return prompt ? `${prompt}\n\n${context}` : context
}
