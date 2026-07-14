import { createFileRoute } from '@tanstack/react-router'
import { WorkspacePage } from '../workspace-page'

function SessionPage() {
  const { sessionId } = Route.useParams()
  return <WorkspacePage sessionId={sessionId} />
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
})
