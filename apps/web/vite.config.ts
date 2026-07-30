import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// WP38 (ADR-0038): base-path build-time'dır; product imajı build'i
// VITE_BASE_PATH'i build-arg'dan geçirir. Boş değer = kök ('/') ve bugünkü
// çıktıyla bire bir aynıdır. Değer normalize beklenir (başta '/', sonda yok).
const basePath = process.env.VITE_BASE_PATH ?? ''
if (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/')))
  throw new Error(
    `VITE_BASE_PATH normalize değil (başta '/', sonda yok): ${basePath}`,
  )

export default defineConfig({
  base: `${basePath}/`,
  server: {
    host: '127.0.0.1',
    port: 3000,
    ...(process.env.WP28_ENTERPRISE_API_ORIGIN
      ? {
          proxy: {
            '/wp28-enterprise-api': {
              target: process.env.WP28_ENTERPRISE_API_ORIGIN,
              rewrite: (path) => path.replace(/^\/wp28-enterprise-api/, ''),
            },
          },
        }
      : {}),
  },
  plugins: [tanstackStart(), viteReact()],
})
