import { defineConfig, devices } from '@playwright/test'

// No chat-server, database, echo bot, LiveKit, or existing preview service.
process.env.E2E_UI_FIXTURES = '1'
const port = Number(process.env.E2E_UI_FIXTURE_PORT ?? 14173)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid UI fixture port')
const origin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: 'e2e',
  testMatch: [
    'reactions.spec.ts',
    'deletion.spec.ts',
    'quality-of-life.spec.ts',
    'composer-spacing.spec.ts',
    'message-interactions.spec.ts',
    'link-actions.spec.ts',
    'draft-storage.spec.ts',
    'fixture-scroll.spec.ts',
    'responsive-details.spec.ts',
    'details-priority.spec.ts',
    'storage-usage.fixture.spec.ts',
    'gif-fixture.spec.ts',
  ],
  workers: 1,
  use: { baseURL: origin },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.PW_ALL_BROWSERS ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, timeout: 60_000, expect: { timeout: 15_000 } },
    ] : []),
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/e2e/interactions-fixture.html`,
    reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
