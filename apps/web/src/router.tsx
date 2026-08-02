import { QueryClient } from '@tanstack/react-query'
import { createRouter, type RouterHistory } from '@tanstack/react-router'
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query'
import { routeTree } from './routeTree.gen'

export function getRouter(history?: RouterHistory) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 5_000, retry: 1 },
    },
  })
  const router = createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    // (ADR-0038): base-path'li kurulumda tüm route'lar base altından
    // eşleşir ve üretilir; kökte BASE_URL '/' olduğundan davranış değişmez.
    basepath: import.meta.env.BASE_URL ?? '/',
    ...(history ? { history } : {}),
  })

  setupRouterSsrQueryIntegration({ router, queryClient })
  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
