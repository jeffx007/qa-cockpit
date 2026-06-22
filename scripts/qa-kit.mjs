#!/usr/bin/env node
// =============================================================================
// qa-kit — run a venture's kit suite headless with accuracy-safe defaults,
//          then triage the result so the verdict reflects REAL bugs only.
// =============================================================================
// Delegates into the venture (no app code here) and runs its kit Playwright
// config with defaults chosen to MINIMISE false-positives:
//   PROJECT=desktop  → chromium only (skips uninstalled firefox/webkit/safari)
//   WORKERS=2        → low provisioning burst (eases the CloudFront WAF throttle)
// Output is teed to .results/last-run.log and piped through scripts/triage.mjs.
// Exit code reflects REAL (unexplained) failures, not raw Playwright failures.
//
//   VENTURE=vb-hopo PROJECT=desktop WORKERS=2 GREP=@smoke node scripts/qa-kit.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, createWriteStream } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

const VENTURE = process.env.VENTURE || 'vb-hopo'
const E2E_BASE_URL = process.env.E2E_BASE_URL || 'https://dev.hopo.io'
const PROJECT = process.env.PROJECT || 'desktop'
const WORKERS = process.env.WORKERS || '2'
const GREP = process.env.GREP || ''
const CONFIG = process.env.KIT_CONFIG || 'e2e-kit/playwright.config.ts'

const ventureDir = resolve(root, '..', 'ventures', VENTURE)
const resultsDir = resolve(root, '.results')
mkdirSync(resultsDir, { recursive: true })
const logPath = resolve(resultsDir, 'last-run.log')

const grepArg = GREP ? `--grep ${JSON.stringify(GREP)}` : ''
const headedArg = process.env.HEADED ? '--headed' : '' // visible browser (watch it run)
const cmd = `npm run env -- playwright test --config ${CONFIG} --project=${PROJECT} --workers=${WORKERS} ${grepArg} ${headedArg} --reporter=list`

console.log(`▶ ${VENTURE} kit · project=${PROJECT} workers=${WORKERS}${GREP ? ` grep=${GREP}` : ''}${headedArg ? ' headed' : ''} · ${E2E_BASE_URL}`)
console.log(`  ${ventureDir}\n  $ ${cmd}\n`)

const out = createWriteStream(logPath)
const run = spawn('sh', ['-c', cmd], {
  cwd: ventureDir,
  env: { ...process.env, E2E_BASE_URL, E2E_TARGET: process.env.E2E_TARGET || 'dev' },
})
const tee = (s) => s.on('data', (d) => { process.stdout.write(d); out.write(d) })
tee(run.stdout)
tee(run.stderr)

run.on('close', () => {
  out.end()
  console.log(`\n${'─'.repeat(64)}`)
  const t = spawn('node', [resolve(__dirname, 'triage.mjs'), logPath, '--venture', VENTURE], {
    stdio: 'inherit',
  })
  t.on('close', (code) => process.exit(code ?? 0))
})
