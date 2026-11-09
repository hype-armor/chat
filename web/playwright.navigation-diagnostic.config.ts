import { defineConfig } from '@playwright/test'
import config from './playwright.config'

const webkit = config.projects?.find((project) => project.name === 'webkit')
if (!webkit) throw new Error('Set PW_ALL_BROWSERS=1 for the WebKit navigation diagnostic')

// Explicit contexts are traced by Playwright itself, including early close and
// shared-fixture teardown. Do not wrap browser.newContext or start a second trace.
export default defineConfig(config, {
  projects: [webkit],
  // These files produced failures in PR #134. Other full-suite predecessors
  // are absent. A passing selected run cannot establish a full-suite fix.
  testMatch: ['**/desktop-layout.spec.ts', '**/safety.spec.ts'],
  workers: 2,
  retries: 0,
  reporter: [['line'], ['json', { outputFile: 'navigation-diagnostic/report.json' }]],
  outputDir: 'navigation-diagnostic/test-results',
  use: {
    // Only isolated synthetic accounts are permitted. Traces can contain tokens,
    // recovery keys and DOM text. Keep failure archives briefly; never post them.
    trace: { mode: 'retain-on-failure', screenshots: false, snapshots: true, sources: false },
    screenshot: 'off',
    video: 'off',
  },
})
