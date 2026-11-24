import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_DELIVERY_STORE_PORT ?? 14238)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid delivery store fixture port')
const origin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: 'e2e', testMatch: 'delivery-store.fixture.spec.ts', workers: 1,
  use: { baseURL: origin },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}) } }],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/e2e/delivery-store-fixture.html`, reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
