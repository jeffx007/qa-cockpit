# manual-qa

Self-contained, **local** QA engine extracted from `vb-hopo` — run your manual QA on this machine without the venture repo. Two parts:

| Part | Files | What it does |
|------|-------|--------------|
| **On-demand role logins** (human QA) | `scripts/qa-manual-user.mjs`, `scripts/qa-manual-code.mjs`, `e2e/manual-profiles.yaml` | Provisions test users via the vb-account E2E helper API, prints creds, fetches OTP, can open a logged-in browser |
| **Manual runbook** (automated specs) | `e2e/__tests__/manual-runbook*.spec.ts` + the copied `e2e/fixtures/`, `e2e/global-*.ts`, `e2e/helpers/`, `playwright.config.ts` | Runnable here — the vb-hopo e2e harness was copied in so the specs resolve standalone |

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
