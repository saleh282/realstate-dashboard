# Phase 13 — environment safety model

Goal: make it hard to reset production, run development seeds in production, run the
local E2E against production, bootstrap a SUPER_ADMIN by accident, or apply a
migration without a recovery point. Everything below is implemented in
`src/config/deployment-environment.ts` and covered by `test/phase13-environment-safety.spec.ts`.

## The four environments

| `DEPLOYMENT_ENV` | Meaning | Required `NODE_ENV` |
|---|---|---|
| `local` | a developer machine or a disposable test database | `development` or `test` |
| `development` | a shared development deployment | `development` or `test` |
| `staging` | pre-production, production-like | `production` |
| `production` | real users | `production` |

* `NODE_ENV=production` **must** declare `DEPLOYMENT_ENV` (`staging` or `production`); startup fails otherwise.
* A development `NODE_ENV` can never claim `staging`/`production`, and vice-versa.
* When `DEPLOYMENT_ENV` is unset outside production it is derived (`test` → `local`, `development` → `development`),
  so existing local workflows are unchanged.
* Any process whose environment cannot be resolved is treated as **protected** (fail safe).

## Database allowlist and identity marker

* `DB_ENV_ALLOWLIST` — comma-separated `host/database` patterns (`*` wildcard). **Required** in staging/production;
  enforced in development only when set. `MONGO_URI` must match, otherwise startup and every CLI refuse.
* Environment identity marker — collection `_environment`, document `{ _id: 'deployment', env, createdAt }`.
  Written once, deliberately:
  ```bash
  DEPLOYMENT_ENV=staging MONGO_URI=... npm run env:init -- --confirm=<host>/<database>
  ```
  The `--confirm` value must equal the target parsed from `MONGO_URI`; an existing marker is never overwritten with a
  different environment. In staging/production the marker is **mandatory**: the API refuses to start
  (`EnvironmentGuardService`) and every CLI refuses if it is missing or names another environment. In development
  environments a present marker must still match (a database marked `production` cannot be used by a development process).

## Decision table (`ACTION_RULES`)

| Action | local | development | staging | production |
|---|---|---|---|---|
| dev admin seed (`seed:admin`) | yes | yes | **refused** | **refused** |
| SUPER_ADMIN bootstrap | yes | yes | `SUPER_ADMIN_BOOTSTRAP_CONFIRM=CREATE_SUPER_ADMIN` | `PRODUCTION_BOOTSTRAP_CONFIRM=CREATE_PRODUCTION_SUPER_ADMIN` |
| baseline seed | yes | yes | `BASELINE_SEED_CONFIRM=APPLY_BASELINE` | same |
| `migration:apply` | yes | yes | `MIGRATION_BACKUP_CONFIRM=<snapshot id>` | same |
| `migration:dry-run`, integrity, manifest verify | yes | yes | yes | yes |
| `release:manifest apply` | yes | yes | `MANIFEST_APPLY_CONFIRM=APPLY_MANIFEST` | same |
| destructive reset (harnesses, drills) | `DESTRUCTIVE_CONFIRM=RESET_DISPOSABLE_DATABASE` | **refused** | **refused** | **refused** |
| local E2E suites | yes | yes | **refused** | **refused** |
| fake payment provider | yes | yes | **refused** | **refused** |

The disposable/engineering tools (`phase13-scale-harness`, `phase13-migration-rehearsal`, `phase13-restore-drill`)
additionally require a **localhost** database named `mazad_phase13_*` (`src/scripts/disposable-target.ts`).
`PHASE12_DISPOSABLE_DB=1` is a local-only escape hatch for the legacy seed scripts and is refused unless the
deployment is `local`/`development`.

## Where the guards run

`seed:admin`, `seed:super-admin`, `baseline-catalog.seed`, `migration` (apply and dry-run), `migration:integrity`,
`release:manifest`, `env:init`, the Phase 12/13 scripts and API startup. Adding a new destructive or seeding tool means
adding an `ACTION_RULES` entry and calling `guardAction(...)` first; the table test enforces that every action is listed.

## Payments

`PAYMENT_PROVIDER` is `none` (default, fail closed) or `fake`. `fake` is rejected by environment validation **and**
by the provider factory in staging/production/unresolved environments (two independent layers). No real gateway is
selectable until an adapter exists.
