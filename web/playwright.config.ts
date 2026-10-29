import { defineConfig, devices } from '@playwright/test'

// Locally only Chromium may be installed; CI runs all three engines
// (`PW_ALL_BROWSERS=1`) because Safari/WebKit gaps are a top risk.
const all = !!process.env.PW_ALL_BROWSERS

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: 'http://localhost:4173' },
  webServer: { command: 'pnpm preview --port 4173 --strictPort', port: 4173, reuseExistingServer: !process.env.CI },
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
