import { defineConfig, devices } from '@playwright/test'

// Locally only Chromium may be installed; CI runs all three engines
// (`PW_ALL_BROWSERS=1`) because Safari/WebKit gaps are a top risk.
const all = !!process.env.PW_ALL_BROWSERS
// E2E_SERVER=1 also starts chat-server (needs DATABASE_URL) for the
// messaging tests; its log is where they read verification codes.
const withServer = !!process.env.E2E_SERVER
// E2E_LIVEKIT=ws://127.0.0.1:7880 (a `livekit-server --dev`) turns on the
// group-call tests.
const livekit = process.env.E2E_LIVEKIT

export default defineConfig({
  testDir: 'e2e',
  // The loopback address, not "localhost": Playwright's Firefox gathers no
  // ICE candidates on pages from that name, and the preview binds IPv4 only.
  use: { baseURL: 'http://127.0.0.1:4173' },
  webServer: [
    {
      command: 'pnpm preview --host 127.0.0.1 --port 4173 --strictPort',
      env: livekit ? { CSP_CONNECT_EXTRA: `${livekit} ${livekit.replace(/^ws/, 'http')}` } : {},
      url: 'http://127.0.0.1:4173/',
      reuseExistingServer: !process.env.CI,
    },
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
              // Tests sign up without invites, all from 127.0.0.1.
              CHAT_REGISTRATION: 'open',
              CHAT_LIMIT_REGISTRATIONS_PER_IP_PER_HOUR: '100000',
              CHAT_LIMIT_REGISTRATIONS_PER_DAY: '100000',
              CHAT_LIMIT_INVITES_PER_DAY: '100000',
              CHAT_LIMIT_RESTORES_PER_IP_PER_HOUR: '100000',
              CHAT_LIMIT_LINKS_PER_IP_PER_HOUR: '100000',
              ...(livekit
                ? {
                    CHAT_LIVEKIT_URL: livekit,
                    CHAT_LIVEKIT_API_URL: livekit.replace(/^ws/, 'http'),
                    CHAT_LIVEKIT_API_KEY: 'devkey',
                    CHAT_LIVEKIT_API_SECRET: 'secret',
                  }
                : {}),
            },
          },
          {
            // The echo test bot (echo.00), a real client of that server.
            command: 'cargo run -q -p chat-echo > target/e2e-echo.log 2>&1',
            cwd: '..',
            url: 'http://127.0.0.1:8090/',
            timeout: 300_000,
            reuseExistingServer: !process.env.CI,
            env: {
              ECHO_SERVER: 'http://127.0.0.1:8080',
              ECHO_STATE_DIR: 'target/e2e-echo-state',
              ECHO_HEALTH_BIND: '127.0.0.1:8090',
            },
          },
        ]
      : []),
  ],
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Calls: a fake camera and microphone, and plain host candidates
        // (not mDNS names) between two pages on one machine.
        launchOptions: {
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--disable-features=WebRtcHideLocalIpsWithMdns',
          ],
        },
      },
    },
    ...(all
      ? [
          {
            name: 'firefox',
            use: {
              ...devices['Desktop Firefox'],
              launchOptions: {
                firefoxUserPrefs: {
                  'media.navigator.streams.fake': true,
                  'media.navigator.permission.disabled': true,
                  'media.peerconnection.ice.obfuscate_host_addresses': false,
                  'media.peerconnection.ice.loopback': true,
                },
              },
            },
          },
          { name: 'webkit', use: { ...devices['Desktop Safari'] } },
        ]
      : []),
  ],
})
