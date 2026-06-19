import { defineConfig, devices } from '@playwright/test'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { existsSync } from 'fs'
import { config as loadEnv } from '@dotenvx/dotenvx'

const __dirname = dirname(fileURLToPath(import.meta.url))

const rootEnvPath = resolve(__dirname, '.env')
if (existsSync(rootEnvPath)) {
  loadEnv({ path: rootEnvPath })
}

const target = process.env.E2E_TARGET || 'local'
const isLocal = target === 'local'

// Must match the port Vite listens on (dev:client uses --port 3160).
const localPort = process.env.E2E_PORT || '3160'
const localBase = `http://localhost:${localPort}`

const remoteUrls: Record<string, string> = {
  dev: 'https://dev.hopo.io',
  prod: 'https://hopo.io',
}

// StorageState carries cookie consent only — never JWT tokens.
// Auth tokens live in memory (SDK MemoryStorageAdapter) and are
// injected via OAuth callback in the auth fixture.
// See: patterns/features/e2e_auth.yaml
const storageStatePath = resolve(__dirname, 'e2e/.auth/user.json')

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  retries: isLocal ? 0 : 1,
  timeout: 30_000,
  reporter: process.env.CI
    ? [
        ['json', { outputFile: 'e2e-results.json' }],
        ['html', { open: 'never' }],
      ]
    : 'html',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: 'disabled',
    },
  },
  use: {
    baseURL: isLocal ? localBase : remoteUrls[target] || `https://${target}.hopo.io`,
    storageState: storageStatePath,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'mobile-chrome',
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'mobile-safari',
      use: { ...devices['iPhone 14'] },
    },
  ],
  ...(isLocal && {
    webServer: {
      command: 'npm run dev',
      url: localBase,
      reuseExistingServer: true,
      timeout: 30_000,
      env: {
        APP_ENV: 'local',
        PORT: '3161',
        RP_ID: 'localhost',
        ORIGIN: localBase,
      },
    },
  }),
})
