import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Dedicated services only. Never reuse the normal preview or production ports.
// Create a disposable database first, then explicitly pass its connection URL:
// TMPDIR=/var/tmp E2E_ISOLATED_DATABASE_URL=postgres://... E2E_SERVER=1 \
//   pnpm --filter web exec playwright test -c playwright.interactions.config.ts
const database = process.env.E2E_ISOLATED_DATABASE_URL
if (process.env.E2E_SERVER && !database) {
  throw new Error('Set E2E_ISOLATED_DATABASE_URL to a dedicated disposable database; DATABASE_URL is not a fallback')
}
if (database) {
  const parsed = new URL(database)
  // A distinctive database name prevents an accidental default database run.
  if (!parsed.pathname.startsWith('/chat_ui_e2e_')) {
    throw new Error('The isolated database name must start with chat_ui_e2e_')
  }
}

export default defineConfig({
  ...base,
  testMatch: ['chat.spec.ts'],
  workers: 1,
  use: { ...base.use, baseURL: 'http://127.0.0.1:14173' },
  webServer: [
    {
      command: 'node node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 14173 --strictPort',
      env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080', CSP_CONNECT_EXTRA: '' },
      url: 'http://127.0.0.1:14173/',
      reuseExistingServer: false,
    },
    ...(process.env.E2E_SERVER ? [{
      command: 'cargo run -q -p chat-server > target/e2e-interactions-server.log 2>&1',
      cwd: '..',
      url: 'http://127.0.0.1:18080/readyz',
      timeout: 300_000,
      reuseExistingServer: false,
      env: {
        DATABASE_URL: database!,
        CHAT_BIND: '127.0.0.1:18080',
        CHAT_LOG_FORMAT: 'json',
        CHAT_REGISTRATION: 'open',
        CHAT_LIMIT_REGISTRATIONS_PER_IP_PER_HOUR: '100000',
        CHAT_LIMIT_REGISTRATIONS_PER_DAY: '100000',
        CHAT_LIMIT_LINKS_PER_IP_PER_HOUR: '100000',
        CHAT_LIVEKIT_URL: '',
        CHAT_LIVEKIT_API_URL: '',
        CHAT_LIVEKIT_API_KEY: '',
        CHAT_LIVEKIT_API_SECRET: '',
      },
    }] : []),
  ],
})
