import { test as base } from '@playwright/test'

/**
 * Global test setup fixture that blocks third-party requests (analytics)
 * which delay page load events and cause test timeouts.
 *
 * All test fixtures and spec files should extend from or import this `test`
 * instead of importing directly from '@playwright/test'.
 */
const BLOCKED_PATTERNS = [
  'https://www.googletagmanager.com/**',
  'https://www.google-analytics.com/**',
  'https://www.clarity.ms/**',
]

export const test = base.extend<{ blockThirdParty: void }>({
  blockThirdParty: [
    async ({ page }, use) => {
      for (const pattern of BLOCKED_PATTERNS) {
        await page.route(pattern, (route) => route.abort())
      }
      await use()
    },
    { auto: true },
  ],
})

export { expect } from '@playwright/test'
