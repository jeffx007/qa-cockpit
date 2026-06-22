#!/usr/bin/env node
// =============================================================================
// verify-entitlements — independent, out-of-band proof that the SERVER enforces
//                       entitlement gates (closes the false-negative where the
//                       kit's attemptFeature only checks the UI).
// =============================================================================
// Does NOT trust the kit or the venture adapter. It provisions a real user,
// creates the group context, and calls the gated GraphQL operation ITSELF:
//   FREE  → the server must REJECT  (LIMIT_EXCEEDED / limit=<gate>)
//   PRO   → the server must ALLOW   (after seeding pro via the PR #334 endpoint)
// A "FREE not rejected" is a real entitlement bypass the kit's UI-only test misses.
//
// Run via `npm run hopo:verify` (loads the venture's decrypted env: keys, client id).

import { E2EApiClient, generateEphemeralPassword } from '@buckden/auth-client/testing'

const API = (process.env.VB_ACCOUNT_E2E_URL || process.env.AUTH_URL || process.env.API_URL || '').replace(/\/$/, '')
const API_KEY = process.env.E2E_API_KEY
const CLIENT_ID =
  process.env.E2E_CLIENT_ID || process.env.VITE_AUTH_CLIENT_ID || process.env.E2E_SUB_CLIENT_ID || 'hopo-web'
const GRAPHQL =
  process.env.GRAPHQL_URL || `${(process.env.E2E_BASE_URL || 'https://dev.hopo.io').replace(/\/$/, '')}/graphql`

if (!API || !API_KEY) {
  console.error('verify: missing E2E_API_KEY + AUTH_URL — run via `npm run hopo:verify` so dotenvx loads them.')
  process.exit(2)
}

const client = new E2EApiClient({ baseUrl: API, apiKey: API_KEY, clientId: CLIENT_ID })

async function gql(query, variables, { idToken, groupId } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (idToken) headers['authorization'] = `Bearer ${idToken}`
  if (groupId) headers['x-group-id'] = groupId
  const res = await fetch(GRAPHQL, { method: 'POST', headers, body: JSON.stringify({ query, variables }) })
  return res.json().catch(() => ({}))
}
async function seedSub(email, plan) {
  const url = `${API}/e2e/users/${encodeURIComponent(email)}/subscription?client_id=${encodeURIComponent(CLIENT_ID)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'x-e2e-key': API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ plan }),
  })
  if (!res.ok) throw new Error(`seed ${plan} failed: ${res.status} ${(await res.text()).slice(0, 160)}`)
}
async function clearSub(email) {
  const url = `${API}/e2e/users/${encodeURIComponent(email)}/subscription?client_id=${encodeURIComponent(CLIENT_ID)}`
  await fetch(url, { method: 'DELETE', headers: { 'x-e2e-key': API_KEY } }).catch(() => {})
}

const isLimit = (json, gate) =>
  (json?.errors || []).some(
    (e) => e.extensions?.code === 'LIMIT_EXCEEDED' && (e.extensions?.limit === gate || e.extensions?.limitName === gate)
  )

const CREATE_DWELLING = `mutation($input: CreateDwellingInput!){ createDwelling(input:$input){ id } }`
const CREATE_ROOM = `mutation($input: CreateRoomInput!){ createRoom(input:$input){ id } }`
const CREATE_ITEM = `mutation($input: CreateItemInput!){ createItem(input:$input){ id } }`

// Build the context a probe needs, returning { groupId?, roomId? }. spec.setup wins;
// else needsGroup creates a dwelling; else no context.
async function setupContext(spec, idToken) {
  if (spec.setup) return spec.setup(idToken)
  if (spec.needsGroup) {
    const d = await gql(CREATE_DWELLING, { input: { name: 'Verify House', type: 'HOUSE' } }, { idToken })
    const groupId = d?.data?.createDwelling?.id
    if (!groupId) throw new Error(`createDwelling failed: ${JSON.stringify(d.errors || d).slice(0, 200)}`)
    return { groupId }
  }
  return {}
}

// Setup helper: a dwelling + a room (for item/image probes). Returns { groupId, roomId }.
async function dwellingWithRoom(idToken) {
  const d = await gql(CREATE_DWELLING, { input: { name: 'Verify House', type: 'HOUSE' } }, { idToken })
  const groupId = d?.data?.createDwelling?.id
  if (!groupId) throw new Error(`createDwelling failed: ${JSON.stringify(d.errors || d).slice(0, 160)}`)
  const r = await gql(CREATE_ROOM, { input: { name: 'Verify Room', type: 'BEDROOM' } }, { idToken, groupId })
  const roomId = r?.data?.createRoom?.id
  if (!roomId) throw new Error(`createRoom failed: ${JSON.stringify(r.errors || r).slice(0, 160)}`)
  return { groupId, roomId }
}

// Declarative gate specs. needsGroup → create a dwelling first and send X-Group-Id;
// or supply setup(idToken) → { groupId, roomId } for deeper context.
// buildVars(ctx) (optional) produces the probe variables once per run (FREE+PRO share them).
const GATES = [
  {
    gate: 'export',
    op: 'exportItems',
    probe: `query { exportItems { dwellingName } }`,
    needsGroup: true,
  },
  {
    gate: 'sharing',
    op: 'createInvite',
    probe: `mutation($email: String!, $role: GroupRole!){ createInvite(email: $email, role: $role){ inviteId } }`,
    needsGroup: true,
    buildVars: () => ({
      email: `invitee+${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@e2e.buckden.io`,
      role: 'viewer',
    }),
  },
  {
    gate: 'reminders',
    op: 'createAnnualItem',
    probe: `mutation($input: CreateAnnualItemInput!){ createAnnualItem(input: $input){ id } }`,
    needsGroup: false,
    buildVars: () => ({ input: { name: 'Verify Reminder', type: 'CAR_INSURANCE' } }),
  },
  {
    // FREE maxImagesPerItem=1: a FREE user attaching 3 images to one item SHOULD be
    // rejected; PRO (=3) allowed. NB: grep shows no server enforcement of this limit,
    // so the expected (and useful) outcome is a CONCERN — surfacing an unenforced gate.
    gate: 'maxImagesPerItem',
    op: 'createItem (3 images)',
    probe: CREATE_ITEM,
    setup: dwellingWithRoom,
    buildVars: (ctx) => ({
      input: { roomId: ctx.roomId, description: 'Image limit probe', image: 'img-1', image2: 'img-2', image3: 'img-3' },
    }),
  },
]

// Quota gates: numeric limits. Fill to the FREE limit (allowed), then the next
// create must be rejected (LIMIT_EXCEEDED / limitName=<quota>); PRO raises it.
// heavy:true quotas only run with HEAVY=1 (they need many creates). maxImages(50)
// is left out entirely — images upload via S3 presign, not GraphQL, and grep shows
// no server-side enforcement (flagged in false-negatives.json instead).
const QUOTAS = [
  {
    quota: 'maxDwellings',
    op: 'createDwelling',
    query: CREATE_DWELLING,
    makeVars: (i) => ({ input: { name: `Quota House ${i}`, type: 'HOUSE' } }),
    idOf: (r) => r?.data?.createDwelling?.id,
    freeLimit: 1,
  },
  {
    // FREE maxItems=50: needs a dwelling+room, then 51 items. heavy → opt-in (HEAVY=1).
    quota: 'maxItems',
    op: 'createItem',
    query: CREATE_ITEM,
    setup: dwellingWithRoom,
    makeVars: (i, ctx) => ({ input: { roomId: ctx.roomId, description: `Quota item ${i}` } }),
    idOf: (r) => r?.data?.createItem?.id,
    freeLimit: 50,
    heavy: true,
  },
]

async function verifyQuota(spec) {
  const v = {
    gate: spec.quota,
    op: `${spec.op} beyond ${spec.freeLimit}`,
    freeRejected: null,
    proAllowed: null,
    pass: false,
    notes: [],
  }
  const email = `e2e+verify-${spec.quota}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@e2e.buckden.io`
  const password = generateEphemeralPassword()
  let provisioned = false
  try {
    await client.createUser({ email, password })
    provisioned = true
    const { idToken } = await client.getAuthToken({ email, password })

    const ctx = await setupContext(spec, idToken)
    const groupId = ctx.groupId

    // fill exactly to the free limit — these must all succeed
    for (let i = 1; i <= spec.freeLimit; i++) {
      const r = await gql(spec.query, spec.makeVars(i, ctx), { idToken, groupId })
      if (!spec.idOf(r)) {
        v.notes.push(`setup: create #${i} (within limit) failed: ${JSON.stringify(r.errors || r).slice(0, 160)}`)
        throw new Error('setup-failed')
      }
    }
    // the next create must be rejected for FREE
    const over = await gql(spec.query, spec.makeVars(spec.freeLimit + 1, ctx), { idToken, groupId })
    v.freeRejected = isLimit(over, spec.quota)
    if (!v.freeRejected)
      v.notes.push(`FREE not rejected — server allowed ${spec.op} beyond ${spec.freeLimit}: ${JSON.stringify(over).slice(0, 160)}`)

    // PRO → the next create must be allowed
    await seedSub(email, 'pro')
    const pro = await gql(spec.query, spec.makeVars(spec.freeLimit + 1, ctx), { idToken, groupId })
    v.proAllowed = !!spec.idOf(pro) && !isLimit(pro, spec.quota)
    if (!v.proAllowed)
      v.notes.push(`PRO not allowed — server still blocked ${spec.op} after seeding pro: ${JSON.stringify(pro).slice(0, 160)}`)

    v.pass = v.freeRejected === true && v.proAllowed === true
  } catch (e) {
    if (e.message !== 'setup-failed') v.notes.push(`error: ${e.message}`)
  } finally {
    await clearSub(email)
    if (provisioned) await client.deleteUser(email).catch(() => {})
  }
  return v
}

async function verifyGate(spec) {
  const v = { gate: spec.gate, op: spec.op, freeRejected: null, proAllowed: null, pass: false, notes: [] }
  const email = `e2e+verify-${spec.gate}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@e2e.buckden.io`
  const password = generateEphemeralPassword()
  let provisioned = false
  try {
    await client.createUser({ email, password })
    provisioned = true
    const { idToken } = await client.getAuthToken({ email, password })

    const ctx = await setupContext(spec, idToken)
    const groupId = ctx.groupId
    const vars = spec.buildVars ? spec.buildVars(ctx) : {}

    // FREE → must be rejected server-side
    const freeRes = await gql(spec.probe, vars, { idToken, groupId })
    v.freeRejected = isLimit(freeRes, spec.gate)
    if (!v.freeRejected)
      v.notes.push(`FREE not rejected — server allowed ${spec.op} to a free user: ${JSON.stringify(freeRes).slice(0, 180)}`)

    // PRO → must be allowed
    await seedSub(email, 'pro')
    const proRes = await gql(spec.probe, vars, { idToken, groupId })
    v.proAllowed = !isLimit(proRes, spec.gate) && !proRes.errors
    if (!v.proAllowed)
      v.notes.push(`PRO not allowed — server still blocked ${spec.op} after seeding pro: ${JSON.stringify(proRes).slice(0, 180)}`)

    v.pass = v.freeRejected === true && v.proAllowed === true
  } catch (e) {
    v.notes.push(`error: ${e.message}`)
  } finally {
    await clearSub(email)
    if (provisioned) await client.deleteUser(email).catch(() => {})
  }
  return v
}

const C = { dim: '\x1b[2m', red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m', x: '\x1b[0m', b: '\x1b[1m' }
const mark = (ok) => (ok === true ? `${C.grn}✅ yes${C.x}` : ok === false ? `${C.red}❌ NO${C.x}` : `${C.ylw}— ?${C.x}`)

;(async () => {
  console.log(`\n${C.b}Independent Entitlement Verifier${C.x} ${C.dim}— ${GRAPHQL} (client ${CLIENT_ID})${C.x}`)
  console.log(`  ${C.dim}out-of-band server probe — does NOT trust the kit's attemptFeature${C.x}\n`)
  const heavy = !!process.env.HEAVY
  const skipped = []
  const results = []
  for (const spec of GATES) results.push(await verifyGate(spec))
  for (const spec of QUOTAS) {
    if (spec.heavy && !heavy) {
      skipped.push(`${spec.quota} (heavy — set HEAVY=1 to run; ${spec.freeLimit + 1} creates)`)
      continue
    }
    results.push(await verifyQuota(spec))
  }

  let concerns = 0
  for (const v of results) {
    const enforced = v.pass
    console.log(`  ${C.b}${v.gate}${C.x} ${C.dim}(${v.op})${C.x}`)
    console.log(`     FREE rejected by server : ${mark(v.freeRejected)}`)
    console.log(`     PRO  allowed  by server : ${mark(v.proAllowed)}`)
    if (enforced) {
      console.log(`     → ${C.grn}ENFORCED${C.x} ${C.dim}— server gate proven (kit's UI-only check now backed by a real probe)${C.x}`)
    } else {
      concerns++
      console.log(`     → ${C.red}CONCERN${C.x}`)
      for (const n of v.notes) console.log(`        ${C.dim}${n}${C.x}`)
    }
  }
  for (const s of skipped) console.log(`  ${C.dim}⤬ skipped: ${s}${C.x}`)
  console.log(
    `\n  ${C.b}Verdict:${C.x} ${results.length - concerns}/${results.length} gate(s) enforced server-side; ` +
      `${concerns ? C.red : C.grn}${concerns} concern(s).${C.x}` +
      (skipped.length ? ` ${C.dim}(${skipped.length} heavy skipped)${C.x}` : '') +
      '\n'
  )
  process.exit(concerns > 0 ? 1 : 0)
})()
