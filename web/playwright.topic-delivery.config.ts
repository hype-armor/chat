import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_TOPIC_DELIVERY_PORT ?? 14249)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid topic delivery fixture port')
const origin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: 'e2e', testMatch: 'topic-delivery.fixture.ts', workers: 1,
  // Three cold worker/WASM startups can exceed 30 seconds on a busy test host.
  timeout: 90_000,
  use: { baseURL: origin, serviceWorkers: 'block' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ...(process.env.PW_ALL_BROWSERS === '1' ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/e2e/topic-delivery-fixture.html`, reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
