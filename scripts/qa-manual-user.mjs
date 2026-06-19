#!/usr/bin/env node
/**
 * qa-manual-user — on-demand, role-based test logins for MANUAL QA.
 *
 * Reuses the E2E provisioning engine (@buckden/auth-client/testing) but reads a
 * separate `e2e/manual-profiles.yaml` and writes to `e2e/.manual-auth/` so it
 * never touches automated E2E state.
 *
 * Because the app's auth store hydrates from injected tokens
 * (window.__E2E_TOKENS__), `--open` lands you in a REAL browser already logged
 * in — no email/password, no verification code.
 *
 *   node scripts/qa-manual-user.mjs --list
 *   node scripts/qa-manual-user.mjs --role admin --open   # provision + open browser
 *   node scripts/qa-manual-user.mjs --role admin          # provision, print card only
 *   node scripts/qa-manual-user.mjs --cleanup             # tear down
 *
 * Env (auto-detected, same as e2e-provision):
 *   ci-dev → COGNITO_USER_POOL_ID + COGNITO_CLIENT_ID + AWS creds  (recommended)
 *   local  → E2E_API_KEY + VB_ACCOUNT_E2E_URL/AUTH_URL + VITE_AUTH_CLIENT_ID
 *   APP_URL / E2E_BASE_URL → app to open (e.g. https://dev.hopo.io)
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { load as parseYaml } from 'js-yaml'
import {
  provisionEphemeralUsers,
  cleanupEphemeralUsers,
  generateEphemeralPassword,
  E2EApiClient,
} from '@buckden/auth-client/testing'

const PROFILES_PATH = resolve(process.cwd(), 'e2e/manual-profiles.yaml')
const AUTH_DIR = 'e2e/.manual-auth'
const MANIFEST_PATH = resolve(process.cwd(), AUTH_DIR, 'profiles.json')
const REGION = process.env.AWS_REGION ?? 'eu-west-2'

const C = { g: '\x1b[32m', y: '\x1b[33m', b: '\x1b[34m', d: '\x1b[2m', r: '\x1b[31m', x: '\x1b[0m', bold: '\x1b[1m' }
const log = (...a) => console.log(...a)
const die = (m) => { console.error(`${C.r}[qa-manual-user] ${m}${C.x}`); process.exit(1) }

// ---- args ----
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
const wantRole = val('--role')
const doList = has('--list')
const doCleanup = has('--cleanup')
const doOpen = has('--open')
const doApi = has('--api') // force the E2E-API (no-AWS) path even if COGNITO_USER_POOL_ID is set

const API_BASE = process.env.API_URL ?? process.env.VB_ACCOUNT_E2E_URL ?? process.env.AUTH_URL ?? ''
const API_CLIENT = process.env.E2E_CLIENT_ID ?? process.env.VITE_AUTH_CLIENT_ID ?? 'buckden-web'

// ---- config ----
if (!existsSync(PROFILES_PATH)) die(`Missing ${PROFILES_PATH}. Copy manual-profiles.example.yaml into the venture's e2e/ folder.`)
const fullConfig = parseYaml(readFileSync(PROFILES_PATH, 'utf-8'))
const venture = fullConfig.venture
if (!venture) die('manual-profiles.yaml is missing a top-level `venture:` field.')
const allRoles = Object.keys(fullConfig.profiles ?? {})
if (allRoles.length === 0) die('No profiles defined in manual-profiles.yaml.')

if (doList) {
  log(`\n${C.bold}Manual QA personas for ${venture}${C.x}`)
  for (const [name, p] of Object.entries(fullConfig.profiles)) {
    const groups = p.groups?.length ? p.groups.join(', ') : '(default user)'
    const tier = p.dynamo_seed?.length ? ' · seeds data' : ''
    log(`  ${C.g}${name.padEnd(14)}${C.x} ${C.d}groups:${C.x} ${groups}${tier}`)
  }
  log('')
  process.exit(0)
}

function detectEnv() {
  if (doApi) {
    if (!process.env.E2E_API_KEY) die('--api set but E2E_API_KEY is missing. It lives in the venture .env — run via the npm script so dotenvx loads it.')
    return 'local-dev'
  }
  if (process.env.COGNITO_USER_POOL_ID) return 'ci-dev'
  if (process.env.E2E_API_KEY) return 'local-dev'
  die('Cannot detect environment. Set E2E_API_KEY (API path, no AWS) or COGNITO_USER_POOL_ID (+ AWS creds). Run inside the venture repo with its env loaded.')
}
function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) return null
  try { return JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) } catch { return null }
}

// ---- cleanup ----
async function cleanup() {
  const manifest = loadManifest()
  if (!manifest || !Object.keys(manifest.profiles ?? {}).length) { log(`${C.y}No active manual users to clean up.${C.x}`); return }
  const envType = detectEnv()
  if (envType === 'ci-dev') {
    await cleanupEphemeralUsers({ manifest, userPoolId: process.env.COGNITO_USER_POOL_ID, region: REGION })
  } else {
    const client = new E2EApiClient({ baseUrl: API_BASE, apiKey: process.env.E2E_API_KEY, clientId: API_CLIENT })
    for (const p of Object.values(manifest.profiles)) await client.deleteUser(p.email).catch(() => {})
  }
  writeFileSync(MANIFEST_PATH, JSON.stringify({ ...manifest, profiles: {}, cleanedAt: new Date().toISOString() }, null, 2))
  log(`${C.g}Cleaned up ${Object.keys(manifest.profiles).length} manual user(s) for ${venture}.${C.x}`)
}

// ---- provision ----
async function provision() {
  let profiles = fullConfig.profiles
  if (wantRole) {
    if (!profiles[wantRole]) die(`Unknown role "${wantRole}". Available: ${allRoles.join(', ')}`)
    profiles = { [wantRole]: profiles[wantRole] }
  }
  const config = { ...fullConfig, profiles }
  const envType = detectEnv()
  const runId = `manual-${Date.now().toString(36)}`
  const password = generateEphemeralPassword()
  mkdirSync(resolve(AUTH_DIR), { recursive: true })

  const prev = loadManifest()
  if (prev && Object.keys(prev.profiles ?? {}).length) {
    try { if (envType === 'ci-dev') await cleanupEphemeralUsers({ manifest: prev, userPoolId: process.env.COGNITO_USER_POOL_ID, region: REGION }) } catch { /* ignore */ }
  }

  let manifest
  if (envType === 'ci-dev') {
    manifest = await provisionEphemeralUsers({ config, runId, password, userPoolId: process.env.COGNITO_USER_POOL_ID, clientId: process.env.COGNITO_CLIENT_ID ?? '', region: REGION, authDir: AUTH_DIR })
  } else {
    if (!API_BASE) die('E2E API base URL missing — set API_URL (or AUTH_URL / VB_ACCOUNT_E2E_URL) in the venture .env.')
    const client = new E2EApiClient({ baseUrl: API_BASE, apiKey: process.env.E2E_API_KEY, clientId: API_CLIENT })
    manifest = { venture, runId, createdAt: new Date().toISOString(), password, profiles: {}, dynamoItems: [] }
    for (const [name, p] of Object.entries(config.profiles)) {
      const email = `${venture}+e2e-${p.suffix}-${runId}@buckden.io`
      await client.createUser({ email, password, ...(p.groups?.[0] && { cognitoGroup: p.groups[0] }) })
      const tokens = await client.getAuthToken({ email, password })
      const tokenFile = p.token_file ?? `${name}-token.json`
      writeFileSync(resolve(AUTH_DIR, tokenFile), JSON.stringify(tokens, null, 2))
      manifest.profiles[name] = { email, userId: '', tokenFile }
    }
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2))
  }

  printCards(manifest)
  if (doOpen) await openBrowser(manifest)
}

function printCards(manifest) {
  const appUrl = process.env.APP_URL ?? process.env.E2E_BASE_URL ?? '(set APP_URL to show app link)'
  const pw = manifest.password
  log(`\n${C.bold}Manual QA logins ready — ${venture}${C.x}  ${C.d}(${detectEnv()} · run ${manifest.runId})${C.x}`)
  log(`${C.d}App: ${appUrl}${C.x}\n`)
  for (const [name, p] of Object.entries(manifest.profiles)) {
    const def = fullConfig.profiles[name]
    const role = def?.groups?.length ? def.groups.join(', ') : 'default user'
    log(`  ${C.g}${C.bold}${name}${C.x}  ${C.d}(${role})${C.x}`)
    log(`    email    ${C.b}${p.email}${C.x}`)
    log(`    password ${C.b}${pw}${C.x}`)
    log(`    token    ${C.d}${AUTH_DIR}/${p.tokenFile}${C.x}`)
    log('')
  }
  if (!doOpen) log(`${C.d}Tip: add --open to launch a logged-in browser. Cleanup: --cleanup${C.x}\n`)
}

// ---- open a real browser, already authenticated (skips the verification code) ----
async function openBrowser(manifest) {
  const role = wantRole ?? Object.keys(manifest.profiles)[0]
  const prof = manifest.profiles[role]
  if (!prof) die(`No provisioned token for role "${role}".`)
  const appUrl = (process.env.APP_URL ?? process.env.E2E_BASE_URL ?? '').replace(/\/$/, '')
  if (!appUrl) die('Set APP_URL (e.g. https://dev.hopo.io) to open a browser.')
  const tokenData = JSON.parse(readFileSync(resolve(AUTH_DIR, prof.tokenFile), 'utf-8'))

  let chromium
  try { ({ chromium } = await import('playwright')) }
  catch { die('Playwright not installed in this repo — cannot open a browser. The login card above still works for token-based access.') }

  log(`${C.d}Opening browser as ${C.x}${C.bold}${role}${C.x}${C.d} → ${appUrl}/home …${C.x}`)
  const browser = await chromium.launch({ headless: false })
  const ctx = await browser.newContext({ viewport: null })
  await ctx.addInitScript(
    ({ id, access }) => { window.__E2E_TOKENS__ = { idToken: id, accessToken: access } },
    { id: tokenData.idToken, access: tokenData.accessToken }
  )
  const page = await ctx.newPage()
  await page.goto(`${appUrl}/home`, { waitUntil: 'domcontentloaded' }).catch(() => {})
  log(`${C.g}Logged in as ${role}. Test away — close the browser window when done.${C.x}`)
  log(`${C.d}Then run cleanup to delete the user.${C.x}\n`)
  await new Promise((res) => browser.on('disconnected', res))
}

// ---- main ----
;(async () => {
  if (doCleanup) await cleanup()
  else await provision()
})().catch((e) => die(e?.message ?? String(e)))
