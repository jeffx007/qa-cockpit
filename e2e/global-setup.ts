/**
 * Playwright globalSetup — runs once before all E2E tests.
 *
 * Local:  writes storageState with cookie consent. Mock SDK auto-authenticates.
 * Dev/CI: verifies pre-provisioned tokens from e2e-provision CLI exist.
 *         Cleans up orphaned dwellings from previous test runs.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb'

const __dirname = dirname(fileURLToPath(import.meta.url))

const AUTH_DIR = resolve(__dirname, '.auth')
const STORAGE_STATE_PATH = resolve(AUTH_DIR, 'user.json')
const TOKEN_PATH = resolve(AUTH_DIR, 'admin-token.json')

export default async function globalSetup() {
  const target = process.env.E2E_TARGET || 'local'

  console.log(`\n[e2e] Hopo Global Setup (target: ${target})`)

  mkdirSync(AUTH_DIR, { recursive: true })

  if (target === 'local') {
    await setupLocal()
  } else {
    if (!existsSync(TOKEN_PATH) && !existsSync(resolve(AUTH_DIR, 'profiles.json'))) {
      throw new Error(
        `Missing auth tokens in ${AUTH_DIR} — run npx e2e-provision first (CI does this automatically)`
      )
    }
    console.log('  Using pre-provisioned auth tokens from e2e/.auth/')

    // Write storageState with cookie consent (never JWT — memory-only auth)
    const remoteUrls: Record<string, string> = {
      dev: 'https://dev.hopo.io',
      staging: 'https://staging.hopo.io',
      prod: 'https://hopo.io',
    }
    const origin = process.env.E2E_BASE_URL || remoteUrls[target] || `https://${target}.hopo.io`

    const storageState = {
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
    }
    writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2))

    // Seed SUBSCRIPTION records for profiles that need Pro tier.
    // e2e-provision creates Cognito users but doesn't seed DynamoDB yet (vb-account#114).
    // Non-fatal: without AWS creds the seed is skipped — only Pro-tier / RBAC tests
    // fail individually; the rest of the suite (Navigation, CRUD, negatives) still runs.
    try {
      await seedSubscriptions()
    } catch (err) {
      console.warn(
        `[e2e] seedSubscriptions skipped (no AWS creds?) — Pro-tier/RBAC tests will fail: ${(err as Error).message}`
      )
    }

    // Clean up orphaned dwellings from previous failed runs
    const tokenData = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'))
    if (tokenData.accessToken) {
      await cleanupOrphanedDwellings(origin, tokenData.accessToken)
    }
  }

  console.log('[e2e] Global setup complete\n')
}

async function setupLocal() {
  const origin = `http://localhost:${process.env.E2E_PORT || '3160'}`

  const storageState = {
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
  }

  writeFileSync(STORAGE_STATE_PATH, JSON.stringify(storageState, null, 2))
  writeFileSync(TOKEN_PATH, JSON.stringify({ target: 'local' }, null, 2))
  console.log(`  Wrote local storageState for ${origin}`)
}

function getUserIdFromToken(tokenFile: string): string | null {
  try {
    const data = JSON.parse(readFileSync(resolve(AUTH_DIR, tokenFile), 'utf-8'))
    const token = data.idToken || data.accessToken || ''
    const parts = token.split('.')
    if (parts.length < 2) return null
    const payload = Buffer.from(parts[1], 'base64url').toString()
    return JSON.parse(payload).sub ?? null
  } catch {
    return null
  }
}

async function seedSubscriptions(): Promise<void> {
  const table = process.env.DYNAMODB_TABLE || 'vb-hopo-dev'
  const region = process.env.AWS_REGION || 'eu-west-2'
  const proProfiles = [
    { file: 'admin-token.json', customerId: 'cus_e2e_admin' },
    { file: 'pro-token.json', customerId: 'cus_e2e_pro' },
    { file: 'invitee-token.json', customerId: 'cus_e2e_invitee' },
  ]

  const dynamo = new DynamoDBClient({ region })
  let seeded = 0

  for (const { file, customerId } of proProfiles) {
    const userId = getUserIdFromToken(file)
    if (!userId) continue

    await dynamo.send(
      new PutItemCommand({
        TableName: table,
        Item: {
          PK: { S: `USER#${userId}` },
          SK: { S: 'SUBSCRIPTION' },
          entityType: { S: 'SUBSCRIPTION' },
          planName: { S: 'pro' },
          planId: { S: 'e2e-pro' },
          stripeCustomerId: { S: customerId },
          stripeSubscriptionId: { S: `sub_e2e_${customerId.split('_').pop()}` },
          status: { S: 'active' },
          tier: { S: 'pro' },
          currentPeriodStart: { S: '2026-01-01T00:00:00Z' },
          currentPeriodEnd: { S: '2099-12-31T23:59:59Z' },
          cancelAtPeriodEnd: { BOOL: false },
        },
      })
    )
    seeded++
  }

  console.log(`  Seeded ${seeded} SUBSCRIPTION record(s) in ${table}`)
}

async function cleanupOrphanedDwellings(baseUrl: string, accessToken: string): Promise<void> {
  const graphqlUrl = `${baseUrl}/graphql`

  try {
    const listRes = await fetch(graphqlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ query: '{ dwellings { id name } }' }),
    })
    const listData = (await listRes.json()) as {
      data?: { dwellings?: Array<{ id: string; name: string }> }
    }
    const dwellings = listData.data?.dwellings ?? []

    if (dwellings.length === 0) {
      console.log('  No orphaned dwellings to clean up')
      return
    }

    console.log(`  Cleaning up ${dwellings.length} orphaned dwelling(s)...`)
    for (const d of dwellings) {
      try {
        const delRes = await fetch(graphqlUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
            'X-Group-Id': d.id,
          },
          body: JSON.stringify({
            query: 'mutation ($id: ID!) { deleteDwelling(id: $id) }',
            variables: { id: d.id },
          }),
        })
        const delData = (await delRes.json()) as { errors?: Array<{ message: string }> }
        if (delData.errors?.length) {
          console.warn(`    Failed to delete ${d.name}: ${delData.errors[0].message}`)
        } else {
          console.log(`    Deleted: ${d.name} (${d.id})`)
        }
      } catch {
        console.warn(`    Failed to delete ${d.name} (${d.id})`)
      }
    }
  } catch (err) {
    console.warn('  Warning: orphan cleanup failed:', err)
  }
}
