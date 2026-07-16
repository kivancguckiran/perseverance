export function tenantCacheNamespace(
  subject: string,
  organizationId: string,
  workspaceId: string,
) {
  return `${subject}:${organizationId}:${workspaceId}`
}

export function offlineHistoryKey(namespace: string) {
  return `offline-workspace-history-v2:${namespace}`
}

export function offlineConversationKey(namespace: string, sessionId: string) {
  return `offline-conversation-v2:${namespace}:${sessionId}`
}
