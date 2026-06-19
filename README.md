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

```bash
ROLE=viewer npm run hopo:drive            # paused live viewer session in vb-hopo
VENTURE=vb-hopo ROLE=admin npm run drive  # generic form, any venture
npm run hopo:ui                           # Playwright UI Mode (full kit suite)
E2E_BASE_URL=https://dev.hopo.io npm run codegen
npm run report
```

**AWS:** `owner` and the system roles (`super-admin`/`manager`/`support-agent`) run with
the venture's `.env` alone. `admin`/`member`/`viewer` additionally need **AWS credentials**
(Pro-tier seeding so the owner can invite them into a group at that role).

> The `qa:*` scripts below are a **separate**, self-contained manual-LOGIN tool (provisions
> a user + prints creds / opens a logged-in browser); the cockpit scripts above are the
> delegating drive harness. They don't overlap.

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
The official **`@buckden/e2e` kit** (in `../e2e/`, RFC 0002) now provides config-driven, cross-venture **navigation / rbac / subscription / session / boundary** suites via `runKit`. It **supersedes the runbook specs** here. The genuinely unique, still-useful piece is the **`qa:*` on-demand human-login tooling**, which the automated kit does not replace.

Extracted from `vb-hopo` branch `test/manual-runbook-rbac-tier` (PR #235).
