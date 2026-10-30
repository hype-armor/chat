import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'
import { readFileSync } from 'node:fs'

// Production security headers (CSP, COOP/COEP...) live in the nginx config.
// `vite preview` serves the same headers so e2e tests catch CSP breakage.
function productionHeaders(): Record<string, string> {
  const conf = readFileSync(new URL('../deploy/docker/security-headers.inc.template', import.meta.url), 'utf8')
  const headers: Record<string, string> = {}
  for (const [, name, value] of conf.matchAll(/^add_header (\S+) "(.*)" always;$/gm)) {
    // e2e runs pass the test LiveKit's address (group calls).
    headers[name] = value.replace(' ${CSP_CONNECT_EXTRA}', process.env.CSP_CONNECT_EXTRA ? ` ${process.env.CSP_CONNECT_EXTRA}` : '')
  }
  return headers
}

// The web app talks to the server on the same origin (/v1). In development
// and preview, proxy those requests to a locally running chat-server.
const serverUrl = process.env.CHAT_SERVER_URL ?? 'http://127.0.0.1:8080'
const proxy = { '/v1': { target: serverUrl, ws: true } }

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Hand-written service worker (ADR-0004): we need full control over
      // update gating (docs/04-security-and-cryptography.md §9).
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectRegister: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,svg,png,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Chat',
        short_name: 'Chat',
        description: 'End-to-end encrypted messenger',
        theme_color: '#1f6feb',
        background_color: '#0d1117',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  server: { proxy },
  preview: { headers: productionHeaders(), proxy },
  build: { target: 'es2022' },
  test: { include: ['src/**/*.test.ts'] },
})
