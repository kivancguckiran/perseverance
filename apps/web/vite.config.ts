import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
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
