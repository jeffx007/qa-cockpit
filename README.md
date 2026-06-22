# manual-qa

Self-contained, **local** QA engine extracted from `vb-hopo` — run your manual QA on this machine without the venture repo. Two parts:

| Part | Files | What it does |
|------|-------|--------------|
| **On-demand role logins** (human QA) | `scripts/qa-manual-user.mjs`, `scripts/qa-manual-code.mjs`, `e2e/manual-profiles.yaml` | Provisions test users via the vb-account E2E helper API, prints creds, fetches OTP, can open a logged-in browser |
| **Manual runbook** (automated specs) | `e2e/__tests__/manual-runbook*.spec.ts` + the copied `e2e/fixtures/`, `e2e/global-*.ts`, `e2e/helpers/`, `playwright.config.ts` | Runnable here — the vb-hopo e2e harness was copied in so the specs resolve standalone |

## Cross-venture QA cockpit (delegating)

This folder doubles as a thin **cockpit** for driving any Buckden venture's *own*
e2e-kit drive harness. The harness is venture-**coupled** (e.g. `vb-hopo/e2e-kit/config.ts`
reads the live Vue router + `shared/access-map.ts` + `@buckden/e2e`), so it must run
**inside the venture** — the cockpit only `cd`s in and invokes that venture's `qa:*`
scripts. **No app-coupled code is copied here.** Secrets stay in the venture (loaded from
its encrypted `.env` via dotenvx + macOS Keychain); the cockpit only forwards `VENTURE`,
`ROLE`, `START`, and `E2E_BASE_URL`.

### Inputs (env vars — all optional, with defaults)

| Var | Default | Meaning |
|-----|---------|---------|
| `VENTURE` | `vb-hopo` | venture folder under `../ventures/` |
| `ROLE` | `owner` | `owner` \| `admin` \| `member` \| `viewer` \| `super-admin` \| `manager` \| `support-agent` |
| `START` | `/home` | landing path after auth |
| `E2E_BASE_URL` | `https://dev.hopo.io` | app URL to drive |

### Cockpit scripts (delegating wrappers)

| Script | Delegates to |
|--------|--------------|
| `npm run drive` | `cd ../ventures/$VENTURE && … npm run qa:drive` — paused live session as `ROLE` |
| `npm run ui` | the venture's `qa:ui` (Playwright UI Mode, full kit suite) |
| `npm run codegen` | the venture's `qa:codegen` against `E2E_BASE_URL` |
| `npm run report` | the venture's `qa:report` |
| `npm run hopo:drive` | `VENTURE=vb-hopo npm run drive` (shortcut) |
| `npm run hopo:ui` | `VENTURE=vb-hopo npm run ui` (shortcut) |
| `npm run hopo:sync` | `cd ../ventures/vb-hopo && npm install` (resync the venture's deps) |
| `npm run hopo:setup` | one-time: venture `npm install` **+ `npx playwright install`** (all browsers — removes cross-browser false-fails) |
| `npm run hopo:test` | **headless kit run + triage** — accuracy-safe defaults (`--project=desktop --workers=2`) |
| `npm run hopo:smoke` | as `hopo:test` but `--grep @smoke` (fast, fewest provisions → least throttle) |
| `npm run triage` | classify the last run's failures (real vs known false-positive) |

Tune a run with env vars: `VENTURE`, `PROJECT` (default `desktop`), `WORKERS` (default `2`), `GREP`, `E2E_BASE_URL`.

The kit suite that `qa:ui` runs (from `@buckden/e2e`, config-driven per venture) currently covers:
**session · navigation · rbac · subscription · boundary · accessibility · isolation**.

> **Run `npm run hopo:sync` (i.e. `npm install` inside the venture) after pulling vb-hopo**
> before `hopo:ui` / `hopo:drive`. The harness imports `@buckden/e2e` from the venture's
> `node_modules`; dependency drift breaks that import resolution.

```bash
npm run hopo:sync                         # npm install inside vb-hopo (run after a pull)
ROLE=viewer npm run hopo:drive            # paused live viewer session in vb-hopo
VENTURE=vb-hopo ROLE=admin npm run drive  # generic form, any venture
npm run hopo:ui                           # Playwright UI Mode (full kit suite, incl. a11y + isolation)
E2E_BASE_URL=https://dev.hopo.io npm run codegen
npm run report
```

**AWS:** `owner` and the system roles (`super-admin`/`manager`/`support-agent`) run with
the venture's `.env` alone. `admin`/`member`/`viewer` additionally need **AWS credentials**
(Pro-tier seeding so the owner can invite them into a group at that role).

> The `qa:*` scripts below are a **separate**, self-contained manual-LOGIN tool (provisions
> a user + prints creds / opens a logged-in browser); the cockpit scripts above are the
> delegating drive harness. They don't overlap.

### Accuracy — triage (real bugs vs. false positives)

A raw kit run's headline number is **not** the bug count. Across our dev runs, a
`420 failed` / `27 failed` result triaged to **0 real bugs** — every failure was a
known false-positive:

| Source | Type | Fix lives in |
|--------|------|--------------|
| firefox/webkit/mobile-safari not installed | environment | `hopo:setup`, or `--project=desktop` |
| CloudFront 403 (provisioning rate-limit under load) | infra | lower `WORKERS` / batch; proper fix in kit provisioner |
| isolation member-mgmt needs a seeded target member | venture test bug | vb-hopo `e2e-kit/config.ts` *(raise an issue)* |
| `/home` readiness testId (`dashboard-stats`) gated on `dwellings>0` | venture test bug | vb-hopo `e2e-kit/config.ts:208` *(raise an issue)* |

`npm run hopo:test` runs the kit headless **and** triages automatically; `npm run triage`
re-classifies the last run (`.results/last-run.log`) or any log you pass it:

```bash
npm run hopo:setup            # one-time: install all browsers in the venture
npm run hopo:smoke            # quick, trustworthy signal (desktop @smoke) + triage
npm run hopo:test             # full desktop kit run + triage
node scripts/triage.mjs <log> # triage an existing Playwright list-reporter log
```

Triage exits non-zero only when a **REAL** (unexplained) failure remains, so it's
CI-usable. The known false-positive patterns live in **`known-issues.json`** — venture
test bugs there should each be tracked as an issue in that venture's repo, and removed
from the file once fixed (so the failure starts counting as real again).

## Setup (one-time)
```bash
npm install
npx playwright install         # browsers
# .env (dotenvx-encrypted, copied from vb-hopo) is gitignored; decrypts via the
# vb_dotenvx_password macOS Keychain secret. Verify: npm run qa:check-env
```

## Scripts

```bash
npm run qa:owner          # provision an owner login (also: admin/member/viewer/superadmin/roles)
npm run qa:code           # fetch the latest OTP/magic-link for a provisioned user
npm run qa:clean          # delete provisioned manual users
npm run qa:check-env      # verify E2E_API_KEY + API_URL are set
npm run test:manual       # run the runbook specs (needs the fixtures — see below)
npm run test:manual:watch # ...headed
```

## Requirements / caveats
- **Env**: the scripts use `dotenvx` with the `vb_dotenvx_password` macOS Keychain secret and a venture `.env` providing `E2E_API_KEY` + `API_URL` (`https://dev.auth.hopo.io`). Run `npm run qa:check-env` to verify. *(The `.env` is not included — it lives in the venture repo.)*
- **RBAC** (`manual-runbook-permissions.spec.ts`) is gated behind `E2E_RBAC=1` and needs AWS creds to seed Pro-tier owners; the credential-free runbook (nav/tier/CRUD/negative) runs without them.
- **Hopo-specific**: routes, selectors, and entity flows (dwelling→room→item) are Hopo's. Other ventures would need their own.

## Status / relationship to `@buckden/e2e`
The official **`@buckden/e2e` kit** (in `../e2e/`, RFC 0002) now provides config-driven, cross-venture **session / navigation / rbac / subscription / boundary / accessibility / isolation** suites via `runKit`. It **supersedes the runbook specs** here. The genuinely unique, still-useful piece is the **`qa:*` on-demand human-login tooling**, which the automated kit does not replace.

Extracted from `vb-hopo` branch `test/manual-runbook-rbac-tier` (PR #235).
