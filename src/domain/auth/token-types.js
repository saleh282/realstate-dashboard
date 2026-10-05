'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const ACCESS_TOKEN_TYPE = 'access';
const PASSWORD_RESET_TOKEN_TYPE = 'password_reset';
const PASSWORD_RESET_AUDIENCE = 'mazad:password-reset';
/**
 * Password-reset tokens are signed with a key that access tokens can never
 * validate against. JWT_RESET_SECRET is preferred; when it is absent the key is
 * derived from the access secret with a fixed domain-separation label.
 */
function derivePasswordResetSecret(configuredSecret, accessSecret) {
  const configured = configuredSecret?.trim();
  if (configured) return configured;
  return createHmac('sha256', accessSecret ?? '')
    .update('mazad:password-reset-token:v1')
    .digest('hex');
}
/** Keyed fingerprint that changes as soon as the stored password hash changes. */
function passwordFingerprint(resetSecret, passwordHash) {
  return createHmac('sha256', resetSecret).update(passwordHash).digest('base64url');
}
function fingerprintsMatch(expected, actual) {
  if (typeof expected !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

Object.assign(exports, {
  ACCESS_TOKEN_TYPE,
  PASSWORD_RESET_TOKEN_TYPE,
  PASSWORD_RESET_AUDIENCE,
  derivePasswordResetSecret,
  passwordFingerprint,
  fingerprintsMatch,
});
