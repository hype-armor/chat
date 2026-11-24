import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.E2E_STORAGE_ATOMIC_PORT ?? 14237)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid storage atomic fixture port')
const origin = `http://127.0.0.1:${port}`
export default defineConfig({
  testDir: 'e2e', testMatch: 'storage-atomic.fixture.spec.ts', workers: 1,
  use: { baseURL: origin },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], ...(process.env.E2E_CHROMIUM_PATH ? { launchOptions: { executablePath: process.env.E2E_CHROMIUM_PATH } } : {}) } },
    ...(process.env.E2E_STORAGE_WEBKIT === '1' ? [{ name: 'webkit', use: { ...devices['Desktop Safari'] } }] : []),
  ],
  webServer: {
    command: `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/e2e/storage-atomic-fixture.html`, reuseExistingServer: false,
    env: { CHAT_SERVER_URL: 'http://127.0.0.1:18080' },
  },
})
