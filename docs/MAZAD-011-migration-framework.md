# MAZAD-011 migration and integrity framework

Database changes never run during Nest application startup. The migration CLI is a separate deployment operation and defaults to read-only dry-run mode.

## Commands

```text
npm run migration:list
npm run migration:check -- --migration=006-property-money-minor-units
npm run migration:apply -- --migration=006-property-money-minor-units --batch-size=250
npm run migration:integrity
npm run migration:integrity:strict
```

`MONGO_URI` is required except for `migration:list`. Use a separate least-privilege deployment credential able to read/write application collections plus `migration_ledger` and `migration_locks`. Never place the URI in command arguments, logs, reports, or repository secrets.

## Deployment gate

1. Take and identify a restorable database backup.
2. Run `migration:check` against staging and archive its JSON report.
3. Run `migration:apply` on staging. Interrupt and resume it once during rehearsal.
4. Run `migration:integrity:strict`; investigate every error and counter warning.
5. Rehearse the migration's declared rollback or **NO AUTOMATIC ROLLBACK** restore/remediation procedure.
6. Repeat dry-run against production. A blocker or failed integrity report stops deployment.
7. Run apply as one deployment job. The lease lock prevents concurrent runners; the ledger and per-batch checkpoint make retries idempotent.
8. Run strict integrity checks and archive the structured output before application rollout.

The runner writes no ledger or lock in dry-run mode. Apply mode creates indexes, obtains the global lease, persists a versioned ledger row, checkpoints after each bounded batch, validates postconditions, and records a redacted failure phase. A completed migration is skipped on rerun. A failed/interrupted migration resumes from its last durable checkpoint.

## Integrity coverage

The read-only checker reports duplicate normalized user identifiers, dangling user references, invalid frozen identity/property states, missing catalog references, and catalog `usageCount` drift. Reports contain counts and bounded document-ID samples only; they do not include emails, phones, document contents, credentials, or evidence URLs.

## Adding a migration

Add a uniquely versioned `MigrationDefinition` to `CORE_MIGRATIONS`. It must provide preflight, one bounded/idempotent batch, post-validation, dependencies, and either an automatic rollback procedure or explicit **NO AUTOMATIC ROLLBACK** restoration/remediation instructions. Never edit the meaning of a migration already applied in any environment; add a new version instead.

The legacy `migrate:006-money` and `migrate:007-identity` commands remain temporarily for rollout compatibility. New deployments use the framework registry. Remove legacy entry points only after environment ledgers and operational runbooks have been verified.

If a legacy command already completed before the framework existed, the first framework apply performs a full preflight, writes no domain changes, validates the already-migrated records, and then creates the authoritative ledger entry. It does not invent a successful ledger entry from an old `migration_runs` row.
