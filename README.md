# Real Estate Backend — Express MVC

Plain JavaScript backend using Node.js, Express and MongoDB/Mongoose. The API includes authentication, accounts, KYC, broker applications, legal documents, geocoding and notifications.

## MVC structure

```text
src/
  server.js       # Connect MongoDB, start HTTP and workers, graceful shutdown
  app.js          # Express application and shared middleware
  routes/         # URLs, authentication, authorization, uploads and validation
  controllers/    # Request actions that call services
  models/         # Mongoose schemas, indexes and model registration
  views/          # JSON response envelope and binary responses
  services/       # Business logic and background workers
  validators/     # Input validation and transformation
  domain/         # Domain constants, policies and provider adapters
  middleware/     # JWT, capabilities, errors, rate limits and uploads
  config/         # Environment, database and explicit service construction
  common/         # Shared utilities
  migrations/     # Database migrations and integrity checks
  scripts/        # Operational commands
```

This is an API, so the view layer renders JSON or binary responses. Services receive their dependencies explicitly in `src/config/services.js`. No Nest modules, decorators, dependency-injection container or TypeScript build is required. Validation rules still use class-validator/class-transformer through ordinary JavaScript function calls.

> **Phase 13 operations docs:** [environment safety](docs/PHASE-13-environment-safety.md) ·
> [release and rollout runbook](docs/PHASE-13-release-runbook.md) ·
> [operations runbooks](docs/PHASE-13-operations-runbooks.md)

## Local setup

Use Node.js 22 LTS and npm 10. The supported ranges are enforced by
`package.json`, and `.nvmrc` selects the Node major for compatible tools.

1. Copy `.env.example` to `.env` and replace every placeholder needed by the features you use.
2. Run `npm ci`.
3. Run `npm run check` and `npm test`.
4. Run `npm run start:dev` only when you intentionally want the API server.

All routes use the `/api/v1` prefix.

## Environment

Always required:

- `NODE_ENV=development|test|production`
- `MONGO_URI`
- `JWT_ACCESS_SECRET`, `JWT_ACCESS_EXPIRES_IN`
- `JWT_REFRESH_SECRET`, `JWT_REFRESH_EXPIRES_IN`

Production additionally requires complete SMTP and Cloudinary values plus `CORS_ORIGINS`. JWT secrets must be at least 32 characters. `MAIL_TLS_REJECT_UNAUTHORIZED=false` is rejected in production.

SMTP variables:

- `MAIL_HOST`, `MAIL_PORT`, `MAIL_SECURE`
- `MAIL_USER`, `MAIL_PASS`
- `MAIL_FROM`
- `MAIL_TLS_REJECT_UNAUTHORIZED` (normally `true`)
- `TEST_EMAIL_TO` only for the private CLI mail test

SMTP is optional in development only when all SMTP variables are omitted. Email registration/reset attempts fail with a controlled `503` if SMTP is unavailable; the API never reports a successful delivery in that case.

Cloudinary variables:

- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`

KYC images are checked for JPEG/PNG/WebP MIME and magic bytes, retain the 5 MB limit, and upload with Cloudinary authenticated delivery. New uploads store their `public_id` metadata so account deletion can remove them. Old records that contain only URLs cannot be streamed or automatically cleaned up until their asset metadata is migrated.

## Reverse proxy and client IP (`TRUST_PROXY`)

Rate limiting is keyed on `req.ip`. By default no proxy is trusted and `X-Forwarded-For` is ignored, so behind a load balancer or the admin dashboard every caller would share one identity. Set `TRUST_PROXY` to a comma-separated list of the IPs/CIDRs (or `loopback`, `linklocal`, `uniquelocal`) of the proxies allowed to set the header: the admin-dashboard server and any ingress in front of this API. Express skips trusted addresses from the right and uses the first untrusted one, so spoofed leftmost entries are never used. A hop count (`TRUST_PROXY=1`) is accepted but is only safe when every request path crosses exactly that many proxies. `true` and match-everything CIDRs are rejected at startup.

**In production `TRUST_PROXY` is required** and the process refuses to start without it. Use `TRUST_PROXY=false` only when clients connect to this API directly (a warning is logged). The rate-limit key is additionally validated: if a trusted proxy forwards something that is not an IP address, the socket peer is used instead, so callers cannot mint unlimited buckets. The throttler store is in memory, so limits apply per instance (run N instances and the effective limit is N times higher); move it to a shared store if that matters. The admin dashboard forwards the client address only when its own `TRUSTED_PROXY_HOPS` is configured.

## Health, readiness and shutdown

- `GET /health/live` answers as long as the process can respond. `GET /health/ready` returns 503 while MongoDB does not answer a ping (2 s timeout) and from the moment shutdown begins. Both are served **outside** the `/api/v1` prefix, are not rate limited, and reveal no versions or error details. Use liveness for restart decisions and readiness for load-balancer routing. Cloudinary and SMTP are deliberately not part of readiness (a third-party outage should not take every instance out of rotation).
- Shutdown hooks are enabled. On `SIGTERM`/`SIGINT` readiness fails first, the process waits `SHUTDOWN_DRAIN_MS` (default 5000 in production, 0 elsewhere) so the load balancer stops routing, then closes the HTTP server and the database connection. If that takes longer than `SHUTDOWN_TIMEOUT_MS` (default 25000) the process exits with code 1. Set the orchestrator's grace period above `SHUTDOWN_TIMEOUT_MS`.
- HTTP keep-alive is 65 s, above the 60 s idle timeout of common load balancers.

## Logging and request ids

Every request gets an `X-Request-Id` (a client-supplied value is kept only if it matches `[A-Za-z0-9._:-]{1,100}`). The same id is returned in the response header and error body, written to every server log line about that request, and stored on audit records created while handling it. The global exception filter logs every unexpected exception and every 5xx as one JSON line (`event`, `requestId`, `method`, path without query string, status, error name/message with credentials redacted) plus a stack trace. Client errors (4xx) are not logged; a caller disconnecting mid-request is logged as a warning. Clients only ever see a generic message for unexpected errors. `unhandledRejection` is logged; `uncaughtException` is logged and exits non-zero so the supervisor restarts the process.

## Upload limits

Uploads are buffered in memory, so they are bounded three ways (all enforced while the body streams in, before any file is processed):

- per-request ceiling on the combined file size (KYC 16 MiB, profile photo 6 MiB, broker 21 MiB) on top of the existing per-file limits; a larger `Content-Length` is rejected with 413 `UPLOAD_REQUEST_TOO_LARGE` before reading the body;
- `UPLOAD_MAX_CONCURRENT_PER_USER` (default 2) simultaneous uploads per account, otherwise 429 `UPLOAD_CONCURRENCY_LIMIT`;
- `UPLOAD_MAX_INFLIGHT_BYTES` (default 256 MiB) buffered across the whole process, otherwise 503 `UPLOAD_CAPACITY_EXCEEDED` with `retryAfterSeconds`.

Size the container memory for `UPLOAD_MAX_INFLIGHT_BYTES` plus the normal baseline. Text fields are capped at 256 KiB each and 100 per request. File-type and magic-byte validation are unchanged.

## Private-asset cleanup worker

Failed deletions of private KYC/title-deed assets are queued in `evidence_cleanup_tasks`. A background worker (`EvidenceCleanupWorker`) retries them: enabled by default outside `NODE_ENV=test`, first pass 15-30 s after boot, then every `CLEANUP_INTERVAL_SECONDS` (default 300, minimum 30), `CLEANUP_BATCH_SIZE` tasks per pass (default 50, max 100). Passes never overlap in a process, and each task is claimed with a lease (`nextAttemptAt`) so several instances never process the same task. Failures back off exponentially (2 min up to 6 h) so one failing asset cannot starve the rest. Deleting an already-deleted asset counts as success. Disable with `CLEANUP_WORKER_ENABLED=false` (for example to run it on one dedicated instance).

Observability (structured JSON log lines): `evidence_cleanup_run` (info/warn) after a pass that did work, `evidence_cleanup_run_failed` (error) when a pass itself fails, and `evidence_cleanup_backlog_alert` (error) when any task has failed 5 or more times or the oldest pending task is older than `CLEANUP_ALERT_AGE_SECONDS` (default 3600). **Alert on those two error events.**

## Geocoding

`GET /api/v1/geocoding/reverse` and `/search` require authentication and the `GEOCODING_USE` capability (active users who may create listings, approved brokers, active staff). Per-IP throttling still applies. The endpoints call a provider behind the `GeocodingProvider` interface: `GEOCODING_PROVIDER=google` (Google Geocoding API for `/reverse`, Places API (New) Text Search for `/search`, both limited to Egypt; requires `GOOGLE_MAPS_SERVER_API_KEY`, a server key restricted to this server's IP and those two APIs), `nominatim` (the default: a Nominatim-compatible HTTP API, i.e. self-hosted Nominatim or a hosted service exposing `/search` and `/reverse`), or `disabled`. The Nominatim settings below do not apply to `google`. `/search` allows 30 requests per minute per IP because the app's map picker searches as the user types (debounced). Configuration: `GEOCODING_PROVIDER_BASE_URL`, `GEOCODING_USER_AGENT`, optional `GEOCODING_API_KEY` (sent as query parameter `GEOCODING_API_KEY_PARAM`, default `key`; never logged). **In production the public `nominatim.openstreetmap.org` service is refused at startup** (its usage policy forbids production-scale use); `GEOCODING_ALLOW_PUBLIC_PROVIDER=true` is an explicit, temporary override. Resource bounds, per process: an LRU cache of `GEOCODING_CACHE_MAX_ENTRIES` (2000), at most `GEOCODING_MAX_QUEUE` (25) requests waiting for a provider slot (further requests get 503 `GEOCODING_BUSY`), a wait limit of `GEOCODING_QUEUE_TIMEOUT_MS` (10 s), `GEOCODING_MAX_CONCURRENCY` and `GEOCODING_MIN_INTERVAL_MS` (defaults 1 and 1100 ms for the public service, 4 and 0 for a private endpoint).

## Token separation

- Access tokens are session-bound (`sid`) and typed (`typ: access`). `JwtStrategy` rejects any token with a `purpose`, a non-access `typ`, or no session.
- Password-reset tokens are signed with a separate key (`JWT_RESET_SECRET`, or derived from the access secret when unset), carry their own audience and type, and are bound to the current password hash: a successful reset (or any other password change) invalidates them, and the write is a compare-and-set so concurrent use cannot succeed twice. Reset tokens issued before this change stop working; users simply request a new code.

## Registration of an unverified email

Registering an email whose account is still unverified replaces that account's password and name with the newest registration, revokes any sessions, and enforces the OTP resend cooldown. Verified accounts are never modified. Only the mailbox owner can complete verification, so a password chosen by a pre-registrant does not survive a later registration by the real owner.

## SMTP verification

Set the SMTP variables and `TEST_EMAIL_TO` to an inbox you control, then run:

```bash
npm run mail:test
```

This command sends a message without an OTP and does not expose a public test endpoint. Successful SMTP acceptance and controlled failure are logged without recipient credentials or message content.

## Authorization

Users default to role `user`. Admin accounts use role `admin`. JWT authentication attaches the current database role; `RolesGuard` performs authorization separately.

- `POST /kyc/submit` and `GET /kyc/status`: authenticated users.

The only admin endpoints are the review of listings (below). KYC and broker applications have no review path yet.

Suspended accounts are rejected on login, access-token validation, and token refresh. The refresh endpoint expects `{ "refreshToken": "..." }` in its JSON request body.

## Listings

A listing is a property offered for sale, for rent or for transfer of its instalment contract.

```
draft --submit--> pending_review --approve--> published --close--> closed
                        \--reject(reason)--> rejected
```

Only `published` listings are public. Any change to the data, photos or video of a listing that the review has seen sends it back to `pending_review`.

- **Browsing (no sign-in):** `GET /listings` (filters, sort, pages), `GET /listings/map?bbox=south,west,north,east`, `GET /listings/:id`.
- **The advertiser:** `POST /listings` creates a draft; `PUT /listings/:id` replaces its data and needs the `version` it started from; `PUT /listings/:id/photos/:shot` fills a required shot; `POST /listings/:id/photos` adds an extra photo; `PUT /listings/:id/video`; `POST /listings/:id/submit`; `POST /listings/:id/close`; `DELETE /listings/:id`; `GET /listings/mine`.
- **The review (staff):** `GET /admin/listings`, `GET /admin/listings/:id`, `POST /admin/listings/:id/approve`, `POST /admin/listings/:id/reject` with a `reason`. Each decision writes an audit row and notifies the advertiser.

Each category has required photo shots (`src/domain/listings/photo-shots.js`); a listing cannot be submitted without them. Photos are uploaded one per request (at most two at a time per account, see Upload limits), up to 20 per listing, plus one video of at most a minute and 50 MB.

Staff accounts are made with `npm run admin:grant -- <email>`, which promotes an account that already signed up. It never creates an account or handles a password, and needs `ADMIN_GRANT_CONFIRM=GRANT_ADMIN` in staging and production.

## Throttling and HTTP hardening

`ThrottlerGuard` is globally active at 20 requests/minute. Sensitive auth routes have tighter per-minute limits: register/forgot/resend at 3, and login/verify/reset at 5. Helmet is active. Development CORS allows local clients unless `CORS_ORIGINS` is set; production requires a comma-separated allowlist.

## SMS limitation

SMS remains intentionally unimplemented. The stub never logs an OTP or phone number and returns a controlled `503`; it does not claim delivery. Phone identifiers are now normalized, but production phone OTP delivery still requires a real provider.

## Phase 1 account contracts

- Email identifiers are trimmed and lowercased.
- Egyptian mobile numbers (`01...`, `20...`, `0020...`, `+20...`) are normalized to `+20...`.
- Saudi mobile numbers (`05...`, `966...`, `00966...`, `+966...`) are normalized to `+966...`.
- Lookup keeps compatibility with common legacy local/international phone representations; new users are stored canonically.
- `PATCH /api/v1/users/me` updates the authenticated user's full name. Email/phone changes remain intentionally unavailable until a re-verification flow is added.
- `PATCH /api/v1/users/me/password` verifies the current password, applies the shared 8-character minimum policy, hashes with the existing bcrypt flow, and revokes all refresh sessions.
- Refresh tokens are single-use. Concurrent requests cannot consume the same stored token more than once.
- Authentication failures expose stable machine-readable `code` values, including `ACCOUNT_NOT_VERIFIED`, `ACCOUNT_SUSPENDED`, `INVALID_CREDENTIALS`, and the OTP error codes.

## Removed features

Auctions, favourites, property listings (with their forms, catalogs and amenities), managed marketing and payments have been removed. The only database migration is `039-legal-documents`, which publishes version 1 of the terms and the privacy policy:

```bash
node src/migrations/cli.js --apply --migration=039-legal-documents
```

Some documents under `docs/` still mention those features (the outbox and notification rollouts in particular); the code is the reference.

## Commands

```bash
npm run check
npm test
npm run build
npm run admin:grant -- someone@example.com
npm run mail:test
```

`npm run check` validates JavaScript syntax and resolves application imports.
`npm run build` runs the same checks; JavaScript runs directly from `src`.
Use `npm start` for normal startup or `npm run start:dev` for Node's watch mode.

Historical phase documents describe the system before the Express migration;
use the folder layout and commands in this README for current development.
