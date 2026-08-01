import { createFileRoute, Outlet } from '@tanstack/react-router'
import { WorkspacePage } from '../workspace-page'
import { ProductionSessionPage } from '../production-session-page'

function SessionPage() {
  const { sessionId } = Route.useParams()
  const productionSurface =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('surface') ===
      'production-ha'
  return (
    <>
      {productionSurface ? (
        <ProductionSessionPage sessionId={sessionId} />
      ) : (
        <WorkspacePage sessionId={sessionId} />
      )}
      <Outlet />
    </>
  )
}

export const Route = createFileRoute('/sessions/$sessionId')({
  component: SessionPage,
})
