import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// In development Vite serves the page and forwards the API to the standalone
// core server (`npm run dev:api`). The dev token is injected here so the browser
// never has to carry one and the production auth gate stays fully enforced.
const API_TARGET = process.env.OPENFIT_DEV_API ?? 'http://127.0.0.1:7789'
const DEV_TOKEN = process.env.OPENFIT_SERVER_TOKEN ?? 'openfit-dev-token'

const withDevToken = {
  target: API_TARGET,
  changeOrigin: false,
  configure: (proxy: { on: (event: string, handler: (proxyReq: { setHeader: (k: string, v: string) => void }) => void) => void }) => {
    proxy.on('proxyReq', (proxyReq) => {
      proxyReq.setHeader('authorization', `Bearer ${DEV_TOKEN}`)
    })
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': withDevToken,
      '/oauth': withDevToken,
    },
  },
})
