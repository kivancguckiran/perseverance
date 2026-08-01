import { createFileRoute } from '@tanstack/react-router'
import { WorkspaceFilePage } from './files.$'

function SessionFilePage() {
  const params = Route.useParams()
  return (
    <WorkspaceFilePage
      path={params._splat ?? ''}
      sessionId={params.sessionId}
    />
  )
}

export const Route = createFileRoute('/sessions/$sessionId/files/$')({
  component: SessionFilePage,
})
