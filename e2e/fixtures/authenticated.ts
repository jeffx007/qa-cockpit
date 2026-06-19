import { test as base } from './global-setup'
import type { Page } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export interface AuthFixtures {
  authenticatedPage: Page
}

/**
 * Authenticated page fixture.
 *
 * Injects auth tokens via window.__E2E_TOKENS__ using addInitScript,
 * so they survive page navigations. The auth store's checkSession()
 * detects the injected tokens on app init and auto-hydrates.
 *
 * Local:       mock SDK auto-authenticates (VITE_APP_ENV=local).
 *              Authorization header is stripped so the dev server
 *              falls back to its mock-user context.
 * Dev/staging: real Cognito tokens from globalSetup (.auth/admin-token.json)
 *              are injected and used for GraphQL auth headers.
 *
 * See: patterns/features/e2e_auth.yaml
 */
export const test = base.extend<AuthFixtures>({
  authenticatedPage: async ({ page }, use) => {
    const target = process.env.E2E_TARGET || 'local'

    if (target === 'local') {
      // Strip Authorization header from GraphQL requests so the dev server
      // falls back to its mock-user context (isDev && !authHeader).
      await page.route('**/graphql', (route) => {
        const headers = { ...route.request().headers() }
        delete headers['authorization']
        route.continue({ headers })
      })

      // Query the server's mock user to get the actual user ID.
      // DEV_USER_ID may differ from the hardcoded default and the test
      // process may not have dotenvx decryption available.
      const apiUrl = process.env.E2E_API_URL || 'http://localhost:3161/graphql'
      const meRes = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: '{ me { id email } }' }),
      })
      const meData = (await meRes.json()) as { data?: { me?: { id: string; email: string } } }
      const mockUserId = meData.data?.me?.id ?? 'dev-user-123'
      const mockEmail = meData.data?.me?.email ?? 'Daffy@Quack.com'

      const regularPayload = {
        sub: mockUserId,
        email: mockEmail,
      }
      const fakeIdToken = `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify(regularPayload)).toString('base64')}.sig`
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: fakeIdToken, access: 'e2e-mock-access-token' }
      )

      await page.goto('/home')
      await page.waitForURL('/home')
    } else {
      // Read real Cognito tokens from globalSetup
      const tokenPath = resolve(__dirname, '../.auth/admin-token.json')
      const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'))

      // Inject tokens via addInitScript — survives page navigations.
      // The auth store checks window.__E2E_TOKENS__ in checkSession().
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: tokenData.idToken, access: tokenData.accessToken }
      )

      // Navigate to home — app init will detect __E2E_TOKENS__ and auto-hydrate.
      // Retry with cache bypass if the page is blank (CloudFront invalidation race).
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto('/home', { waitUntil: 'networkidle' })
        const hasContent = await page.locator('#app').innerHTML()
        if (hasContent.trim().length > 0) break
        if (attempt < 2) await page.waitForTimeout(5_000)
      }
      await page.waitForURL('/home', { timeout: 15_000 })
    }

    await use(page)
  },
})

export { expect } from '@playwright/test'
