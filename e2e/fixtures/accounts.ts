import { test as base } from './global-setup'
import type { Page } from '@playwright/test'
import { readFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PRO_USER_ID = 'e2e-pro-user'

interface AccountFixtures {
  freePage: Page
  adminPage: Page
  proPage: Page
}

function readToken(filename: string): { idToken: string; accessToken: string } | null {
  const tokenPath = resolve(__dirname, `../.auth/${filename}`)
  if (!existsSync(tokenPath)) return null
  const data = JSON.parse(readFileSync(tokenPath, 'utf-8'))
  if (!data.idToken || !data.accessToken) return null
  return { idToken: data.idToken, accessToken: data.accessToken }
}

async function setupAuthenticatedPage(
  page: Page,
  tokenFile: string,
  target: string
): Promise<void> {
  if (target === 'local') {
    await page.route('**/graphql', (route) => {
      const headers = { ...route.request().headers() }
      delete headers['authorization']
      route.continue({ headers })
    })
    await page.goto('/home')
    await page.waitForURL('/home')
  } else {
    const tokens = readToken(tokenFile)
    if (!tokens) throw new Error(`No token file for ${tokenFile} — was globalSetup run?`)

    await page.addInitScript(
      ({ id, access }: { id: string; access: string }) => {
        ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
          idToken: id,
          accessToken: access,
        }
      },
      { id: tokens.idToken, access: tokens.accessToken }
    )

    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto('/home', { waitUntil: 'networkidle' })
      const hasContent = await page.locator('#app').innerHTML()
      if (hasContent.trim().length > 0) break
      if (attempt < 2) await page.waitForTimeout(5_000)
    }
    await page.waitForURL('/home', { timeout: 15_000 })
  }
}

export const test = base.extend<AccountFixtures>({
  proPage: async ({ page }, use) => {
    const target = process.env.E2E_TARGET || 'local'
    if (target === 'local') {
      await page.route('**/graphql', (route) => {
        const headers = { ...route.request().headers() }
        delete headers['authorization']
        headers['x-e2e-user-override'] = PRO_USER_ID
        route.continue({ headers })
      })

      const proPayload = {
        sub: PRO_USER_ID,
        email: `${PRO_USER_ID}@e2e.local`,
      }
      const fakeIdToken = `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify(proPayload)).toString('base64')}.sig`
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: fakeIdToken, access: 'pro-mock-access-token' }
      )

      await page.goto('/home')
      await page.waitForURL('/home')
    } else {
      await setupAuthenticatedPage(page, 'pro-token.json', target)
    }
    await use(page)
  },

  freePage: async ({ page }, use) => {
    const target = process.env.E2E_TARGET || 'local'
    await setupAuthenticatedPage(page, 'free-token.json', target)
    await use(page)
  },

  adminPage: async ({ page }, use) => {
    const target = process.env.E2E_TARGET || 'local'
    if (target === 'local') {
      await page.route('**/graphql', (route) => {
        const headers = { ...route.request().headers() }
        delete headers['authorization']
        headers['x-e2e-user-override'] = 'admin-e2e-user'
        headers['x-e2e-system-admin'] = 'true'
        route.continue({ headers })
      })

      const adminPayload = {
        sub: 'admin-e2e-user',
        email: 'admin-e2e-user@e2e.local',
        'cognito:groups': ['super-admin'],
      }
      const fakeIdToken = `eyJ0eXAiOiJKV1QifQ.${Buffer.from(JSON.stringify(adminPayload)).toString('base64')}.sig`
      await page.addInitScript(
        ({ id, access }: { id: string; access: string }) => {
          ;(window as Record<string, unknown>).__E2E_TOKENS__ = {
            idToken: id,
            accessToken: access,
          }
        },
        { id: fakeIdToken, access: 'admin-mock-access-token' }
      )

      await page.goto('/home')
      await page.waitForURL('/home')
    } else {
      await setupAuthenticatedPage(page, 'admin-token.json', target)
    }
    await use(page)
  },
})

export { expect } from '@playwright/test'
