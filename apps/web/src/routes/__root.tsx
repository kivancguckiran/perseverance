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
import { LanguageSwitcher, LocaleProvider, useTranslations } from '../i18n'

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
      // statik PWA varlıkları base altından servis edilir (kökte no-op).
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
      <LocaleProvider>
        <LanguageSwitcher />
        <Outlet />
        <PwaRuntime />
      </LocaleProvider>
    </RootDocument>
  )
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  )
}

function NotFoundPage() {
  const t = useTranslations()
  return (
    <main className="workspace-shell">
      <p className="eyebrow">404</p>
      <h1>
        {t(
          'This workspace view could not be found.',
          'Bu çalışma alanı görünümü bulunamadı.',
        )}
      </h1>
    </main>
  )
}
