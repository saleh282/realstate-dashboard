# MAZAD-008 session rollout

The refresh-session schema change is additive. New logins issue opaque
`selector.secret` refresh tokens and store only the bcrypt hash of `secret`.
The selector is indexed and contains no authentication secret.

Legacy refresh rows (`selector` absent) remain readable only when accompanied by
a valid legacy refresh JWT. A successful legacy refresh deletes that single row
and upgrades the login to a selector session. Legacy rows otherwise expire via
the existing `expiresAt` TTL index. No raw refresh token is introduced or
backfilled.

Rollout order:

1. Verify the unique sparse selector index can be built and that existing TTL
   and user indexes are healthy.
2. Deploy the backward-compatible backend before either client.
3. Monitor `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED`, and
   `SESSION_REVOKED` rates without logging token values.
4. Deploy Admin and Flutter clients. Existing cookies/storage continue to use
   the unchanged `{ refreshToken }` request and rotated response shape.
5. Retain legacy reads for at least the configured maximum refresh lifetime
   plus deployment rollback window. Removal is a later explicit gate.

Rollback must keep selector-token validation available once new tokens have
been issued. Rolling back to code that only accepts JWT refresh tokens would
force reauthentication and is therefore not a compatible rollback.

Password change and reset revoke every session. Current logout revokes only the
session identified by the access-token `sid`; `/auth/logout-all` revokes every
device. Blocking or permanently banning an account revokes every refresh
session. Reactivation never changes revoked session rows.
