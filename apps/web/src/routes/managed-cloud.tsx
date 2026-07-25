import { createFileRoute } from '@tanstack/react-router'
import { ManagedCloudPage } from '../managed-cloud-page'

export const Route = createFileRoute('/managed-cloud')({
  component: ManagedCloudPage,
})
