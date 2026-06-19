#!/usr/bin/env node
/**
 * qa-manual-code — fetch the login OTP / magic-link for a manual QA user via the
 * deployed E2E helper API (X-E2E-Key header). NO AWS credentials needed.
 *
 *   node scripts/qa-manual-code.mjs --role admin     # OTP/link for provisioned admin
 *   node scripts/qa-manual-code.mjs --email <addr>
 *   node scripts/qa-manual-code.mjs --role admin --wait
 *
 * Env (all normally provided by the venture's decrypted .env via dotenvx):
 *   E2E_API_KEY   — the X-E2E-Key secret  (REQUIRED)
 *   API_URL       — backend base URL serving /e2e/*  (or AUTH_URL / VB_ACCOUNT_E2E_URL)
 *   E2E_CLIENT_ID — X-Client-Id  (default: buckden-web)
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const C = { g:'\x1b[32m', y:'\x1b[33m', b:'\x1b[34m', d:'\x1b[2m', r:'\x1b[31m', x:'\x1b[0m', bold:'\x1b[1m' }
const log = (...a) => console.log(...a)
const die = (m) => { console.error(`${C.r}[qa-manual-code] ${m}${C.x}`); process.exit(1) }

const argv = process.argv.slice(2)
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i+1] : undefined }
const wantRole = val('--role')
let email = val('--email')
const doWait = argv.includes('--wait')

const API_KEY = process.env.E2E_API_KEY
const API_URL = (process.env.API_URL ?? process.env.AUTH_URL ?? process.env.VB_ACCOUNT_E2E_URL ?? '').replace(/\/$/, '')
const CLIENT_ID = process.env.E2E_CLIENT_ID ?? 'buckden-web'
if (!API_KEY) die('E2E_API_KEY not set. It lives in the venture .env — run via the npm script (npm run qa:code) so dotenvx loads it.')
if (!API_URL) die('API_URL not set (also tried AUTH_URL / VB_ACCOUNT_E2E_URL). Set the backend base URL that serves /e2e/*.')

if (!email) {
  const M = resolve(process.cwd(), 'e2e/.manual-auth/profiles.json')
  if (!existsSync(M)) die('No e2e/.manual-auth/profiles.json — provision first (npm run qa:admin), or pass --email.')
  const manifest = JSON.parse(readFileSync(M, 'utf-8'))
  const role = wantRole ?? Object.keys(manifest.profiles ?? {})[0]
  email = manifest.profiles?.[role]?.email
  if (!email) die(`No provisioned email for role "${role}". Roles: ${Object.keys(manifest.profiles ?? {}).join(', ') || '(none)'}`)
}

async function e2eGet(path, params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${API_URL}/e2e${path}?${qs}`, {
    headers: { 'X-E2E-Key': API_KEY, 'X-Client-Id': CLIENT_ID },
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GET /e2e${path} → ${res.status}: ${await res.text()}`)
  return res.json()
}

async function fetchOnce() {
  // Prefer OTP; fall back to magic-link. Both are read-only lookups.
  const otp = await e2eGet('/otp', { email }).catch((e) => { if (String(e).includes('401') || String(e).includes('403')) die(`E2E API rejected the key (${e}). Confirm E2E_API_KEY with Richard.`); return null })
  if (otp?.code) return { kind: 'OTP code', value: otp.code, expiresAt: otp.expiresAt }
  const ml = await e2eGet('/magic-link', { email }).catch(() => null)
  if (ml?.token) return { kind: 'Magic-link token', value: ml.token, expiresAt: ml.expiresAt }
  return null
}

;(async () => {
  const deadline = Date.now() + (doWait ? 90_000 : 0)
  do {
    const hit = await fetchOnce()
    if (hit) {
      log(`\n${C.bold}${hit.kind} for ${email}${C.x}`)
      log(`  ${C.g}${C.bold}${hit.value}${C.x}`)
      if (hit.expiresAt) log(`  ${C.d}expires ${hit.expiresAt}${C.x}`)
      log('')
      return
    }
    if (doWait) { process.stdout.write('.'); await new Promise((r) => setTimeout(r, 4000)) }
  } while (Date.now() < deadline)
  die(`No OTP/magic-link found for ${email}. Trigger the send in the UI first, then re-run (add --wait to poll).`)
})()
