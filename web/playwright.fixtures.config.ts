import { defineConfig, devices } from '@playwright/test'

// No chat-server, database, echo bot, LiveKit, or existing preview service.
process.env.E2E_UI_FIXTURES = '1'
export default defineConfig({
  testDir: 'e2e',
  testMatch: ['message-interactions.spec.ts', 'fixture-scroll.spec.ts'],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:14173' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(process.env.PW_ALL_BROWSERS ? [
      { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
      { name: 'webkit', use: { ...devices['Desktop Safari'] }, timeout: 60_000, expect: { timeout: 15_000 } },
    ] : []),
  ],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 14173 --strictPort',
    url: 'http://127.0.0.1:14173/e2e/interactions-fixture.html',
    reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
