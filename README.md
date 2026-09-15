# Real Estate Auction Backend — Phase 0 baseline and Phase 1 accounts

NestJS + MongoDB backend for authentication and KYC. Phase 0 adds production-safe configuration, role authorization, secure OTP handling, real SMTP delivery, and request throttling.

## Local setup

Use Node.js 22 LTS and npm 10. The supported ranges are enforced by
`package.json`, and `.nvmrc` selects the Node major for compatible tools.

1. Copy `.env.example` to `.env` and replace every placeholder needed by the features you use.
2. Run `npm ci`.
3. Run `npm run typecheck` and `npm test`.
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

KYC images are checked for JPEG/PNG/WebP MIME and magic bytes, retain the 5 MB limit, and upload with Cloudinary authenticated delivery. New uploads store their `public_id` metadata so account deletion can remove them. The admin dashboard retrieves documents through an admin-protected streaming endpoint; direct Cloudinary URLs are not returned by the admin details response. Old records that contain only URLs cannot be streamed or automatically cleaned up until their asset metadata is migrated.

## Development admin seed

Configure:

```dotenv
ADMIN_EMAIL=admin@example.test
ADMIN_PASSWORD=ChangeThisDev1!
ADMIN_FULL_NAME=Development Admin
```

Use your own development password; never commit a real production secret. Then run:

```bash
npm run seed:admin
```

The seed is idempotent. It creates a verified admin if the email is absent, or promotes the existing account to `admin`. It does not reset an existing password. Log in through `POST /api/v1/auth/login` with `ADMIN_EMAIL` and the password originally used to create that account.

## SMTP verification

Set the SMTP variables and `TEST_EMAIL_TO` to an inbox you control, then run:

```bash
npm run mail:test
```

This command sends a message without an OTP and does not expose a public test endpoint. Successful SMTP acceptance and controlled failure are logged without recipient credentials or message content.

## Authorization

Users default to role `user`. Admin accounts use role `admin`. JWT authentication attaches the current database role; `RolesGuard` performs authorization separately.

- `POST /kyc/submit` and `GET /kyc/status`: authenticated users.
- `POST /kyc/review/:userId`: authenticated admins only (`401` unauthenticated, `403` normal user).
- `/admin/users`: admin-only listing, details, status, session revocation, role management, and protected deletion.
- `/admin/kyc`: admin-only listing, review, and authenticated document streaming.
- `/admin/audit-logs` and `/admin/dashboard/metrics`: admin-only audit and metrics APIs.

Suspended accounts are rejected on login, access-token validation, and token refresh. The refresh endpoint expects `{ "refreshToken": "..." }` in its JSON request body.

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

## Commands

```bash
npm run typecheck
npm test
npm run build
npm run seed:admin
npm run mail:test
```

The repository currently has no ESLint configuration, so CI uses TypeScript
typechecking as the static code check. Adding and adopting a lint policy is a
separate task rather than silently accepting lint failures.
