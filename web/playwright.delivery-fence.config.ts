import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_DELIVERY_PORT ?? 14179)
export default defineConfig({
  testDir: 'e2e', testMatch: 'delivery-fence.fixture.spec.ts', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/e2e/delivery-fence-fixture.html`, reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
