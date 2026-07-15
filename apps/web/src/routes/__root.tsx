import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import appStyles from '../styles.css?url'
import { PwaRuntime } from '../pwa-runtime'

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      { title: 'Persistent Codex Workspace' },
      { name: 'theme-color', content: '#0d1714' },
      { name: 'application-name', content: 'Persistent Codex Workspace' },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'icon', href: '/icon.svg', type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: '/icon-192.png' },
    ],
  }),
  notFoundComponent: NotFoundPage,
  component: RootComponent,
})

function RootComponent() {
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <PwaRuntime />
        <Scripts />
      </body>
    </html>
  )
}

function NotFoundPage() {
  return (
    <main className="workspace-shell">
      <p className="eyebrow">404</p>
      <h1>Bu çalışma alanı görünümü bulunamadı.</h1>
    </main>
  )
}
