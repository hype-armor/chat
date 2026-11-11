import { defineConfig } from '@playwright/test'
import fixtures from './playwright.fixtures.config'

// Worker-only native IndexedDB regressions. No server or live deployment.
export default defineConfig({
  ...fixtures,
  testMatch: ['draft-storage.spec.ts', 'storage-reconnect.fixture.spec.ts'],
})
