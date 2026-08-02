import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The base path is selected at build time; the product image build
// VITE_BASE_PATH'i build-arg'dan geçirir. Boş değer = kök ('/') ve bugünkü
// çıktıyla bire bir aynıdır. Değer normalize beklenir (başta '/', sonda yok).
const basePath = process.env.VITE_BASE_PATH ?? ''
if (basePath !== '' && (!basePath.startsWith('/') || basePath.endsWith('/')))
  throw new Error(
    `VITE_BASE_PATH normalize değil (başta '/', sonda yok): ${basePath}`,
  )

export default defineConfig({
  base: `${basePath}/`,
  server: { host: '127.0.0.1', port: 3000 },
  plugins: [tanstackStart(), viteReact()],
})
