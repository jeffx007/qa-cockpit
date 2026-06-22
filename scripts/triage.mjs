#!/usr/bin/env node
// =============================================================================
// triage — turn a noisy Playwright run into an honest verdict
// =============================================================================
// Classifies every failure in a Playwright list-reporter log as a KNOWN
// false-positive (environment, rate-limit, or a tracked venture test bug) vs a
// REAL failure that needs a human. The point: a run that prints "27 failed"
// might be 0 real bugs — this says which.
//
//   node scripts/triage.mjs <log-file> [--venture vb-hopo]
//
// Patterns live in known-issues.json (data-driven, per-venture). Exit code is 1
// if any REAL (unexplained) failure remains, else 0 — so it's CI-usable.

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const KNOWN = JSON.parse(readFileSync(resolve(__dirname, '../known-issues.json'), 'utf8'))
// Watchlist of KIT/venture-side blind spots the cockpit can't fix but must surface
// so a "0 failures" verdict is never mistaken for "everything is verified".
const FN_PATH = resolve(__dirname, '../false-negatives.json')
const FN = existsSync(FN_PATH) ? JSON.parse(readFileSync(FN_PATH, 'utf8')) : {}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')

/** Parse a list-reporter log → { totals, failures[] } with each failure classified. */
export function classify(rawText, venture = 'vb-hopo') {
  const text = stripAnsi(rawText)
  const rules = [...(KNOWN.infra || []), ...(KNOWN[venture] || [])]

  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : 0
  }
  const totals = {
    passed: num(/(\d+)\s+passed/),
    failed: num(/(\d+)\s+failed/),
    skipped: num(/(\d+)\s+skipped/),
    flaky: num(/(\d+)\s+flaky/),
  }

  // The detailed failures section prints one block per failure, each starting
  // "  N) [project] › … › Title" followed by the Error. Split on those headers.
  const blocks = text
    .split(/\n(?=\s*\d+\)\s+\[)/)
    .filter((b) => /^\s*\d+\)\s+\[/.test(b))

  const failures = blocks.map((b) => {
    const header = b.split('\n')[0]
    const project = (header.match(/\[([^\]]+)\]/) || [, '?'])[1]
    const title = (header.split(' › ').pop() || header).replace(/^\s*\d+\)\s*/, '').trim()
    const errLine = (b.match(/^\s*(Error:.*)$/m) || [, ''])[1].trim()

    let category = null
    for (const r of rules) {
      const errHit = r.match && new RegExp(r.match, 'i').test(b)
      const projHit = r.matchProject && new RegExp(r.matchProject, 'i').test(project)
      if (errHit || projHit) {
        category = r
        break
      }
    }
    return { project, title, errLine, category }
  })

  return { totals, failures }
}

/** Per-category (suite) pass/fail/skip from the list-reporter result lines. */
export function resultsByCategory(rawText) {
  const text = stripAnsi(rawText)
  const cats = new Map()
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([✓✘\-])\s+\d+\s+\[([^\]]+)\]\s+›\s+(.+)$/)
    if (!m) continue
    const [, mark, , rest] = m
    const parts = rest.split(' › ')
    if (parts.length < 3) continue // path › category › test
    const category = parts[1].trim()
    const test = parts.slice(2).join(' › ').replace(/\s*\([\d.]+m?s\)\s*$/, '').trim()
    const c = cats.get(category) || { pass: 0, fail: 0, skip: 0, failures: [] }
    if (mark === '✓') c.pass += 1
    else if (mark === '✘') (c.fail += 1), c.failures.push(test)
    else c.skip += 1
    cats.set(category, c)
  }
  return cats
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const vIdx = args.indexOf('--venture')
  const venture = vIdx >= 0 ? args[vIdx + 1] : 'vb-hopo'
  const file =
    args.find((a, i) => !a.startsWith('--') && i !== vIdx + 1) ??
    resolve(__dirname, '../.results/last-run.log')

  if (!existsSync(file)) {
    console.error(`triage: no log file at ${file}\nUsage: node scripts/triage.mjs <log-file> [--venture <name>]`)
    process.exit(2)
  }

  const raw = readFileSync(file, 'utf8')
  const { totals, failures } = classify(raw, venture)
  const cats = resultsByCategory(raw)

  const groups = {}
  const real = []
  for (const f of failures) {
    if (!f.category) real.push(f)
    else {
      const g = (groups[f.category.id] ||= { reason: f.category.reason, fix: f.category.fix, n: 0 })
      g.n += 1
    }
  }

  const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', x: '\x1b[0m', b: '\x1b[1m' }
  console.log(`\n${C.b}QA Accuracy Triage${C.x} ${C.dim}— ${file} (venture: ${venture})${C.x}`)
  console.log(`  Run: ${C.grn}${totals.passed} passed${C.x} · ${totals.failed} failed · ${totals.skipped} skipped`)

  // ── Results by category (suite) ──
  if (cats.size) {
    const rows = [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    const w = Math.max(22, ...rows.map(([k]) => k.length))
    let tp = 0, tf = 0, ts = 0
    console.log(`\n  ${C.b}Results by category${C.x} ${C.dim}(project: desktop)${C.x}`)
    console.log(`  ${'Category'.padEnd(w)}  Pass  Fail  Skip`)
    console.log(`  ${'─'.repeat(w + 18)}`)
    for (const [cat, c] of rows) {
      tp += c.pass; tf += c.fail; ts += c.skip
      const fail = c.fail ? `${C.red}${String(c.fail).padStart(4)}${C.x}` : String(c.fail).padStart(4)
      const name = c.fail ? `${C.b}${cat.padEnd(w)}${C.x}` : cat.padEnd(w)
      console.log(`  ${name}  ${C.grn}${String(c.pass).padStart(4)}${C.x}  ${fail}  ${String(c.skip).padStart(4)}`)
      for (const f of c.failures) console.log(`  ${C.dim}${' '.repeat(w)}    ↳ ✘ ${f}${C.x}`)
    }
    console.log(`  ${'─'.repeat(w + 18)}`)
    console.log(`  ${C.b}${'TOTAL'.padEnd(w)}${C.x}  ${C.grn}${String(tp).padStart(4)}${C.x}  ${tf ? C.red : ''}${String(tf).padStart(4)}${C.x}  ${String(ts).padStart(4)}`)
  }

  console.log(`\n  ${C.b}Classified ${failures.length} failure(s):${C.x}\n`)

  for (const [id, g] of Object.entries(groups)) {
    console.log(`  ${C.ylw}❌ false-positive${C.x} · ${C.b}${id}${C.x} — ${g.n}`)
    console.log(`       ${C.dim}${g.reason}${g.fix ? `  [fix: ${g.fix}]` : ''}${C.x}`)
  }

  console.log(`\n  ${real.length ? C.red : C.grn}🔴 REAL (needs review): ${real.length}${C.x}`)
  for (const f of real) {
    console.log(`       ${C.b}[${f.project}]${C.x} ${f.title}`)
    if (f.errLine) console.log(`         ${C.dim}${f.errLine}${C.x}`)
  }

  const fp = failures.length - real.length
  console.log(
    `\n  ${C.b}Verdict:${C.x} ${fp}/${failures.length} failure(s) are known false-positives; ` +
      `${real.length ? C.red : C.grn}${real.length} need review.${C.x}`
  )

  // ── False-negative watchlist: blind spots that pass but aren't really verified ──
  const caveats = [...(FN.global || []), ...(FN[venture] || [])]
  if (caveats.length) {
    console.log(
      `\n  ${C.ylw}⚠ Trust caveats — ${caveats.length} area(s) NOT actually verified (false-negative risk):${C.x}`
    )
    for (const c of caveats) {
      console.log(`     ${C.b}${c.id}${C.x} ${C.dim}(${c.severity}, ${c.owner})${C.x}`)
      console.log(`        ${C.dim}claim: ${c.claim}${C.x}`)
      console.log(`        ${C.dim}blind: ${c.blindSpot}${C.x}`)
    }
    console.log(
      `     ${C.dim}→ a green result here proves nothing for these; fix in the owner repo (tracked) or run the independent verifier.${C.x}`
    )
  }
  console.log('')
  process.exit(real.length > 0 ? 1 : 0)
}
