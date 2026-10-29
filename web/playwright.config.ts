import { defineConfig, devices } from '@playwright/test'

// Locally only Chromium may be installed; CI runs all three engines
// (`PW_ALL_BROWSERS=1`) because Safari/WebKit gaps are a top risk.
const all = !!process.env.PW_ALL_BROWSERS
// E2E_SERVER=1 also starts chat-server (needs DATABASE_URL) for the
// messaging tests; its log is where they read verification codes.
const withServer = !!process.env.E2E_SERVER

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: [
    { command: 'pnpm preview --port 4173 --strictPort', port: 4173, reuseExistingServer: !process.env.CI },
    ...(withServer
      ? [
          {
            command: 'cargo run -q -p chat-server > target/e2e-server.log 2>&1',
            cwd: '..',
            url: 'http://127.0.0.1:8080/readyz',
            timeout: 300_000,
            reuseExistingServer: !process.env.CI,
            env: {
              CHAT_BIND: '127.0.0.1:8080',
              CHAT_LOG_FORMAT: 'json',
              // Every test signs up from 127.0.0.1 with +1555 numbers.
              CHAT_LIMIT_CODES_PER_IP_PER_HOUR: '100000',
              CHAT_LIMIT_CODES_PER_PREFIX_PER_HOUR: '100000',
              CHAT_LIMIT_CODES_PER_DAY: '100000',
            },
          },
        ]
      : []),
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    ...(all
      ? [
          { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
})
