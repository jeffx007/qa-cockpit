import { test as accountsTest } from './accounts'
import type { Page, APIRequestContext, BrowserContext } from '@playwright/test'
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const LOCAL_INVITEE_USER_ID = 'e2e-invitee-user'
const LOCAL_INVITEE_EMAIL = `${LOCAL_INVITEE_USER_ID}@e2e.local`

function readInviteeToken(): { idToken: string; accessToken: string; sub: string; email: string } {
  const tokenPath = resolve(__dirname, '../.auth/invitee-token.json')
  const tokenData = JSON.parse(readFileSync(tokenPath, 'utf-8'))
  const payload = JSON.parse(Buffer.from(tokenData.idToken.split('.')[1], 'base64').toString())
  return {
    idToken: tokenData.idToken,
    accessToken: tokenData.accessToken,
    sub: payload.sub,
    email: payload.email,
  }
}

export interface InviteeFixtures {
  inviteeUserId: string
  inviteeEmail: string
  inviteeRequest: APIRequestContext
  inviteeContext: BrowserContext
  inviteePage: Page
}

const target = process.env.E2E_TARGET || 'local'

export const test = accountsTest.extend<InviteeFixtures>({
  // eslint-disable-next-line no-empty-pattern
  inviteeUserId: async ({}, use) => {
    await use(target === 'local' ? LOCAL_INVITEE_USER_ID : readInviteeToken().sub)
  },
  // eslint-disable-next-line no-empty-pattern
  inviteeEmail: async ({}, use) => {
    await use(target === 'local' ? LOCAL_INVITEE_EMAIL : readInviteeToken().email)
  },

  inviteeRequest: async ({ playwright }, use) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }

    if (target === 'local') {
      headers['x-e2e-user-override'] = LOCAL_INVITEE_USER_ID
    } else {
      const token = readInviteeToken()
      headers['Authorization'] = `Bearer ${token.accessToken}`
    }

    const remoteUrls: Record<string, string> = {
      dev: 'https://dev.hopo.io',
      prod: 'https://hopo.io',
    }
    const apiUrl =
      process.env.E2E_API_URL ||
      (target === 'local'
        ? 'http://localhost:3161'
        : remoteUrls[target] || `https://${target}.hopo.io`)
    const baseURL = apiUrl.replace(/\/graphql$/, '')
    const context = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: headers,
    })

    await use(context)
    await context.dispose()
  },

  inviteeContext: async ({ browser }, use) => {
    const remoteOrigins: Record<string, string> = {
      dev: 'https://dev.hopo.io',
      prod: 'https://hopo.io',
    }
    const port = process.env.E2E_PORT || '3160'
    const origin =
      target === 'local'
        ? `http://localhost:${port}`
        : remoteOrigins[target] || `https://${target}.hopo.io`
    const context = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [
          {
            origin,
            localStorage: [
              { name: 'hopo_cookie_consent', value: 'denied' },
              { name: 'hopo-onboarding-complete', value: 'true' },
            ],
          },
        ],
      },
    })
    await use(context)
    await context.close()
  },

  inviteePage: async ({ inviteeContext }, use) => {
    const page = await inviteeContext.newPage()

    for (const pattern of [
      'https://www.googletagmanager.com/**',
      'https://www.google-analytics.com/**',
      'https://www.clarity.ms/**',
    ]) {
      await page.route(pattern, (route) => route.abort())
    }

    if (target === 'local') {
      await page.route('**/graphql', (route) => {
        const headers = { ...route.request().headers() }
        delete headers['authorization']
        headers['x-e2e-user-override'] = LOCAL_INVITEE_USER_ID
        route.continue({ headers })
      })

      const inviteePayload = { sub: LOCAL_INVITEE_USER_ID, email: LOCAL_INVITEE_EMAIL }
      const fakeIdToken = `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify(inviteePayload)).toString('base64')}.sig`
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: fakeIdToken, access: 'invitee-mock-access-token' }
      )
    } else {
      const token = readInviteeToken()
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: token.idToken, access: token.accessToken }
      )
    }

    await use(page)
  },
})

export { expect } from '@playwright/test'
