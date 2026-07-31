import type { QueryClient } from '@tanstack/react-query'
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { withBase } from '../base-path'
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
      { title: 'Perseverance' },
      { name: 'theme-color', content: '#f3f2f2' },
      { name: 'application-name', content: 'Perseverance' },
    ],
    links: [
      { rel: 'stylesheet', href: appStyles },
      // WP38: statik PWA varlıkları base altından servis edilir (kökte no-op).
      { rel: 'manifest', href: withBase('/manifest.webmanifest') },
      { rel: 'icon', href: withBase('/icon.svg'), type: 'image/svg+xml' },
      { rel: 'apple-touch-icon', href: withBase('/icon-192.png') },
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
