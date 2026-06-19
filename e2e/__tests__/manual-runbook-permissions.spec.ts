/**
 * manual-runbook-permissions.spec.ts
 *
 * Permissions (RBAC) category of the Manual QA runbook — a breadth smoke of the
 * owner/admin/member/viewer matrix. Roles are assigned by seeding a group invite
 * (as owner) and accepting it (as invitee), the same pattern as
 * group-role-ui.spec.ts.
 *
 * FLAGGED OUT BY DEFAULT. These need the OWNER to be Pro tier (sharing is
 * Pro-gated), which requires AWS subscription seeding in global-setup. Without
 * AWS creds the seed is skipped and these fail. So the whole suite is skipped
 * unless E2E_RBAC=1 — set it (with creds) when Richard runs the credentialed
 * pass. Exhaustive RBAC coverage already lives in group-role-ui.spec.ts.
 */
import { test as rbacTest, expect } from '../fixtures/invitee-context'
import {
  seedDwelling,
  seedRoom,
  seedGroupInvite,
  acceptGroupInvite,
  deleteDwelling,
} from '../fixtures/seed'

const target = process.env.E2E_TARGET || 'local'
const rbacEnabled = process.env.E2E_RBAC === '1'

// Role-fixture token files (distinct users on dev; user-override on local).
const ownerTokenFile = target === 'local' ? undefined : 'pro-token.json'
const inviteeTokenFile = target === 'local' ? undefined : 'invitee-token.json'

rbacTest.describe('Manual QA · Permissions', () => {
  rbacTest.skip(!rbacEnabled, 'RBAC needs Pro-tier seeding (AWS creds) — set E2E_RBAC=1 to run')
  rbacTest.skip(
    target === 'prod',
    'Prod maps all profiles to one smoke user — RBAC needs distinct users'
  )

  let dwellingId: string | undefined
  rbacTest.afterEach(async ({ request }) => {
    if (dwellingId) {
      await deleteDwelling(request, dwellingId, ownerTokenFile).catch(() => {})
      dwellingId = undefined
    }
  })

  rbacTest(
    'MQA-PERM-001: viewer sees dwelling read-only',
    async ({ inviteePage, inviteeEmail, inviteeRequest, request }) => {
      const dwelling = await seedDwelling(
        request,
        { name: `MQA Perm Viewer ${Date.now()}` },
        ownerTokenFile
      )
      dwellingId = dwelling.id
      await seedRoom(request, dwelling.id, { name: 'Perm Room', type: 'BEDROOM' })
      const invite = await seedGroupInvite(
        request,
        dwelling.id,
        inviteeEmail,
        'viewer',
        ownerTokenFile
      )
      await acceptGroupInvite(inviteeRequest, invite.inviteId, inviteeTokenFile)

      await inviteePage.goto(`/dwellings/${dwelling.id}`)
      await expect(inviteePage.getByText('Perm Room').first()).toBeVisible({ timeout: 10_000 })
      await expect(inviteePage.getByTestId('edit-dwelling-button')).not.toBeVisible()

      await inviteePage.goto(`/dwellings/${dwelling.id}/members`)
      await expect(inviteePage.getByTestId('member-list')).toBeVisible({ timeout: 10_000 })
      await expect(
        inviteePage.getByRole('button', { name: 'Invite', exact: true })
      ).not.toBeVisible()
    }
  )

  rbacTest(
    'MQA-PERM-002: member has CRUD but no member management',
    async ({ inviteePage, inviteeEmail, inviteeRequest, request }) => {
      const dwelling = await seedDwelling(
        request,
        { name: `MQA Perm Member ${Date.now()}` },
        ownerTokenFile
      )
      dwellingId = dwelling.id
      const invite = await seedGroupInvite(
        request,
        dwelling.id,
        inviteeEmail,
        'member',
        ownerTokenFile
      )
      await acceptGroupInvite(inviteeRequest, invite.inviteId, inviteeTokenFile)

      await inviteePage.goto(`/dwellings/${dwelling.id}/members`)
      await expect(inviteePage.getByTestId('member-list')).toBeVisible({ timeout: 10_000 })
      await expect(
        inviteePage.getByRole('button', { name: 'Invite', exact: true })
      ).not.toBeVisible()
      await expect(inviteePage.locator('[data-testid^="member-role-"]')).toHaveCount(0)
    }
  )

  rbacTest(
    'MQA-PERM-003: admin sees member-management controls',
    async ({ inviteePage, inviteeEmail, inviteeRequest, request }) => {
      const dwelling = await seedDwelling(
        request,
        { name: `MQA Perm Admin ${Date.now()}` },
        ownerTokenFile
      )
      dwellingId = dwelling.id
      const invite = await seedGroupInvite(
        request,
        dwelling.id,
        inviteeEmail,
        'admin',
        ownerTokenFile
      )
      await acceptGroupInvite(inviteeRequest, invite.inviteId, inviteeTokenFile)

      await inviteePage.goto(`/dwellings/${dwelling.id}/members`)
      await expect(inviteePage.getByTestId('member-list')).toBeVisible({ timeout: 10_000 })
      await expect(inviteePage.getByRole('button', { name: 'Invite', exact: true })).toBeVisible()
    }
  )

  rbacTest(
    'MQA-PERM-004: owner sees all controls on members page',
    async ({ proPage: ownerPage, request }) => {
      const dwelling = await seedDwelling(
        request,
        { name: `MQA Perm Owner ${Date.now()}` },
        ownerTokenFile
      )
      dwellingId = dwelling.id
      await ownerPage.goto(`/dwellings/${dwelling.id}/members`)
      await expect(ownerPage.getByTestId('member-list')).toBeVisible({ timeout: 10_000 })
      await expect(ownerPage.getByRole('button', { name: 'Invite', exact: true })).toBeVisible()
    }
  )

  rbacTest('MQA-PERM-005: non-admin denied /admin route', async ({ inviteePage: page }) => {
    await page.goto('/admin')
    await page.waitForTimeout(2_000)
    // The router guard (super_admin/manager only) redirects a regular user away.
    await expect(page).not.toHaveURL(/\/admin(\/|$)/)
  })
})
