/**
 * manual-runbook.spec.ts
 *
 * The Manual QA runbook (QA - Manual Supercharged System / 03-Venture-Runbooks)
 * encoded as automated tests, following hopo's existing e2e conventions
 * (token-injection fixtures + seed helpers). Runs via `npm run test:e2e:dev`
 * — no manual login / MFA codes.
 *
 * Categories: Auth · Navigation · Subscriptions · Venture Logic · Negative/Limit.
 * These are CREDENTIAL-FREE (free-tier defaults, no AWS subscription seeding).
 *
 * Permissions (RBAC) lives in manual-runbook-permissions.spec.ts — it needs
 * Pro-tier subscription seeding (AWS creds) so it is flagged out by default and
 * only runs with E2E_RBAC=1 (e.g. in Richard's credentialed CI). Exhaustive RBAC
 * coverage is in group-role-ui.spec.ts.
 *
 * Known bugs found by manual/agentic QA are encoded with `test.fail()` so the
 * suite stays green while guarding the bug — when it's fixed, the test starts
 * "unexpectedly passing" and you remove the `.fail()`.
 */
import { test, expect } from '../fixtures/authenticated'
import { test as freeTest } from '../fixtures/accounts'
import { seedDwelling, deleteDwelling } from '../fixtures/seed'

const target = process.env.E2E_TARGET || 'local'

// ───────────────────────────────────────────────────────────────────────────
// 1 · Auth — login UX is manual-only (token injection skips the real flow)
// ───────────────────────────────────────────────────────────────────────────
test.describe('Manual QA · Auth', () => {
  test('MQA-AUTH-001: authenticated user lands on /home', async ({ authenticatedPage: page }) => {
    await expect(page.getByTestId('add-property-button')).toBeVisible({ timeout: 15_000 })
  })

  // The email → password → 6-digit MFA flow can only be exercised through the
  // real UI (see authentication.spec.ts / manual runbook). Token-injected
  // suites cannot test it — keep it in the manual pass.
  test.skip('MQA-AUTH-002: real login + MFA flow — MANUAL ONLY', () => {})
})

// ───────────────────────────────────────────────────────────────────────────
// 2 · Navigation
// ───────────────────────────────────────────────────────────────────────────
test.describe('Manual QA · Navigation', () => {
  test('MQA-NAV-001: public pages render', async ({ page }) => {
    for (const path of ['/faq', '/privacy', '/terms']) {
      await page.goto(path)
      await expect(page.locator('main, article')).toBeVisible({ timeout: 10_000 })
    }
  })

  test('MQA-NAV-002: unknown route shows 404, not blank', async ({ page }) => {
    await page.goto('/this-route-does-not-exist')
    await expect(page.getByText(/page not found/i)).toBeVisible({ timeout: 10_000 })
  })

  // Authenticated navigation — every top-level route must render (not blank,
  // not the 404 page) for a logged-in user. Catches broken / orphaned routes.
  const AUTHED_ROUTES = ['/home', '/dwellings', '/annual-items', '/search', '/settings']
  for (const path of AUTHED_ROUTES) {
    test(`MQA-NAV-003: ${path} renders when authenticated`, async ({ authenticatedPage: page }) => {
      await page.goto(path)
      await expect(page.locator('#app')).not.toBeEmpty()
      await expect(page.getByText(/page not found/i)).toHaveCount(0)
    })
  }

  test('MQA-NAV-005: sidebar/menu links resolve (no dead links)', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/home')
    const navLinks = page.locator('nav a[href^="/"], aside a[href^="/"]')
    const count = await navLinks.count()
    expect(count).toBeGreaterThan(0)
    const hrefs = [
      ...new Set(await navLinks.evaluateAll((els) => els.map((e) => e.getAttribute('href')))),
    ]
    for (const href of hrefs) {
      if (!href || href.includes(':')) continue
      await page.goto(href)
      await expect(page.getByText(/page not found/i)).toHaveCount(0)
    }
  })

  test('MQA-NAV-006: back / forward preserves navigation (authenticated)', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/home')
    await page.goto('/dwellings')
    await page.goBack()
    await expect(page).toHaveURL(/\/home/)
    await page.goForward()
    await expect(page).toHaveURL(/\/dwellings/)
  })

  test('MQA-NAV-007: /admin console renders for super-admin', async ({
    authenticatedPage: page,
  }) => {
    // authenticatedPage uses the super-admin profile token → /admin should load.
    // (The "non-admin is redirected" case lives in Permissions / group-role-ui.)
    await page.goto('/admin')
    await expect(page).toHaveURL(/\/admin/)
    await expect(page.getByText(/page not found/i)).toHaveCount(0)
  })

  // KNOWN BUG: robots.txt advertises a sitemap.xml that isn't served — the SPA
  // returns its 404 HTML instead of XML. Remove `test.fail()` once a real
  // sitemap is generated (or the robots reference removed).
  test('MQA-NAV-004: /sitemap.xml is valid XML', async ({ request }) => {
    test.fail()
    const res = await request.get('/sitemap.xml')
    expect(res.headers()['content-type'] ?? '').toContain('xml')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 3 · Subscriptions — free-tier Pro-gating. Free is the default tier (no AWS
// subscription seeding needed), so these run credential-free on dev.
// ───────────────────────────────────────────────────────────────────────────
freeTest.describe('Manual QA · Subscriptions', () => {
  freeTest.skip(target === 'local', 'Local treats all users as Pro')
  freeTest.skip(target === 'prod', 'Prod uses a single shared user')

  // A free user owns at most ONE dwelling — seed once and reuse across cases so
  // we never trip the create-limit from the test setup itself.
  let dwellingId: string | undefined
  async function ensureDwelling(request: Parameters<typeof seedDwelling>[0]) {
    if (!dwellingId) {
      const dwelling = await seedDwelling(
        request,
        { name: `MQA Free ${Date.now()}` },
        'free-token.json'
      )
      dwellingId = dwelling.id
    }
    return dwellingId
  }
  freeTest.afterAll(async ({ request }) => {
    if (dwellingId) await deleteDwelling(request, dwellingId, 'free-token.json').catch(() => {})
  })

  freeTest(
    'MQA-SUB-001: free user is Pro-gated on sharing',
    async ({ freePage: page, request }) => {
      const id = await ensureDwelling(request)
      await page.goto(`/dwellings/${id}/members`)
      await expect(page.getByText(/upgrade to pro/i)).toBeVisible({ timeout: 10_000 })
    }
  )

  // Mirrors E2E-TIER-001. Asserts the owned-dwelling quota gate (see #187 —
  // shared dwellings must not count, only owned ones).
  freeTest(
    'MQA-SUB-002: free user cannot create a second owned dwelling',
    async ({ freePage: page, request }) => {
      await ensureDwelling(request) // free user now owns 1
      await page.goto('/dwellings/add')
      await page.waitForLoadState('networkidle')
      await expect(page.getByTestId('add-dwelling-form')).not.toBeVisible({ timeout: 5_000 })
      await expect(page.getByTestId('upgrade-button')).toBeVisible({ timeout: 10_000 })
    }
  )

  freeTest('MQA-SUB-003: export blocked for free tier', async ({ freePage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('export-csv-button')).not.toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('subscription-upgrade-button')).toBeVisible({ timeout: 10_000 })
  })

  freeTest('MQA-SUB-004: annual items blocked for free tier', async ({ freePage: page }) => {
    await page.goto('/annual-items/add')
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('add-annual-item-form')).not.toBeVisible({ timeout: 5_000 })
    await expect(page.getByTestId('upgrade-button')).toBeVisible({ timeout: 10_000 })
  })

  freeTest('MQA-SUB-005: upgrade button triggers checkout flow', async ({ freePage: page }) => {
    await page.goto('/settings')
    await page.waitForLoadState('networkidle')
    const upgradeBtn = page.getByTestId('subscription-upgrade-button')
    await expect(upgradeBtn).toBeVisible({ timeout: 10_000 })
    await Promise.all([
      page.waitForResponse((r) => r.url().includes('/graphql') || r.url().includes('auth'), {
        timeout: 15_000,
      }),
      upgradeBtn.click(),
    ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 4 · Venture Logic — the dwelling → room → item chain (as owner)
// ───────────────────────────────────────────────────────────────────────────
test.describe('Manual QA · Venture Logic', () => {
  let dwellingId: string | undefined
  test.afterEach(async ({ request }) => {
    if (dwellingId) {
      await deleteDwelling(request, dwellingId).catch(() => {})
      dwellingId = undefined
    }
  })

  test('MQA-VL-001: create dwelling → room (UI)', async ({ authenticatedPage: page }) => {
    const name = `MQA Home ${Date.now()}`
    await page.goto('/dwellings/add')
    await page.locator('#name').fill(name)
    await page.getByTestId('create-dwelling-button').click()
    await page.waitForURL('/home')

    const card = page.getByTestId('dwelling-card').filter({ hasText: name })
    await expect(card).toBeVisible({ timeout: 10_000 })
    await card.click()
    await page.waitForURL(/\/dwellings\//)
    dwellingId = page.url().split('/dwellings/')[1]

    // add a room
    await page.goto(`/dwellings/${dwellingId}/rooms/add`)
    await page.locator('#name').fill('Lounge')
    await page.getByTestId('create-room-button').click()
    await expect(page.getByTestId('room-card').filter({ hasText: 'Lounge' })).toBeVisible({
      timeout: 10_000,
    })
  })

  // KNOWN BUG (found in manual/agentic QA): after creating a room the sidebar
  // still reads "No rooms yet" until you navigate/refresh — the sidebar query
  // isn't invalidated. Remove `test.fail()` once the sidebar updates reactively.
  test('MQA-VL-002: sidebar updates live after creating a room', async ({
    authenticatedPage: page,
    request,
  }) => {
    test.fail()
    const dwelling = await seedDwelling(request, { name: `MQA Sidebar ${Date.now()}` })
    dwellingId = dwelling.id
    await page.goto(`/dwellings/${dwelling.id}`)
    await page.goto(`/dwellings/${dwelling.id}/rooms/add`)
    await page.locator('#name').fill('Kitchen')
    await page.getByTestId('create-room-button').click()
    // without a manual refresh, the sidebar should already show the room
    await expect(page.locator('aside, nav').getByText('Kitchen')).toBeVisible({ timeout: 3_000 })
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 5 · Negative & limit
// ───────────────────────────────────────────────────────────────────────────
test.describe('Manual QA · Negative & limit', () => {
  test('MQA-NEG-001: empty required field blocks save', async ({ authenticatedPage: page }) => {
    await page.goto('/dwellings/add')
    await page.getByTestId('create-dwelling-button').click()
    // stays on the add page (no navigation to /home) → validation blocked it
    await expect(page).toHaveURL(/\/dwellings\/add/)
  })

  test('MQA-NEG-002: bad :id does not leak / shows 404 or empty', async ({
    authenticatedPage: page,
  }) => {
    await page.goto('/dwellings/zzzz-not-a-real-id')
    await expect(page.getByText(/not found|no .*found|doesn't exist/i)).toBeVisible({
      timeout: 10_000,
    })
  })

  // Payment negative tests (−£1, > £20 FDZ cap) — NOT YET TESTABLE: hopo's Pro
  // enrolment/payment flow isn't live ("available soon" per the FAQ). Add these
  // once the upgrade flow ships.
  test.skip('MQA-NEG-003: payment of −£1 rejected — BLOCKED (flow not live)', () => {})
  test.skip('MQA-NEG-004: payment above £20 (FDZ cap) blocked — BLOCKED (flow not live)', () => {})
})

// Permissions (RBAC) → manual-runbook-permissions.spec.ts (needs AWS creds for
// Pro-tier seeding; flagged out unless E2E_RBAC=1). Full coverage in
// group-role-ui.spec.ts. To run everything: `npm run test:e2e:dev`.
