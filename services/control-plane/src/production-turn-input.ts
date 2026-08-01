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
    attachmentContextEnd,
  ].join('\n')
  return prompt ? `${prompt}\n\n${context}` : context
}
