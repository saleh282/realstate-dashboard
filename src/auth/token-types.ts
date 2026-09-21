import { createHmac, timingSafeEqual } from 'crypto';

export const ACCESS_TOKEN_TYPE = 'access';
export const PASSWORD_RESET_TOKEN_TYPE = 'password_reset';
export const PASSWORD_RESET_AUDIENCE = 'mazad:password-reset';

/**
 * Password-reset tokens are signed with a key that access tokens can never
 * validate against. JWT_RESET_SECRET is preferred; when it is absent the key is
 * derived from the access secret with a fixed domain-separation label.
 */
export function derivePasswordResetSecret(
  configuredSecret: string | undefined,
  accessSecret: string | undefined,
): string {
  const configured = configuredSecret?.trim();
  if (configured) return configured;
  return createHmac('sha256', accessSecret ?? '')
    .update('mazad:password-reset-token:v1')
    .digest('hex');
}

/** Keyed fingerprint that changes as soon as the stored password hash changes. */
export function passwordFingerprint(resetSecret: string, passwordHash: string): string {
  return createHmac('sha256', resetSecret).update(passwordHash).digest('base64url');
}

export function fingerprintsMatch(expected: unknown, actual: string): boolean {
  if (typeof expected !== 'string') return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}
