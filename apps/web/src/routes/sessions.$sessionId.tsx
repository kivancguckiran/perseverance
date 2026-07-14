import { createFileRoute } from '@tanstack/react-router'
import { WorkspacePage } from '../workspace-page'

export const Route = createFileRoute('/sessions/$sessionId')({
  component: WorkspacePage,
})
