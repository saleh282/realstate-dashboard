import { isPublicOsmNominatim } from '../geocoding/geocoding.config';
import { REALTIME_MAX_MESSAGE_BYTES_HARD_CAP, REALTIME_TOPOLOGY_SINGLE_INSTANCE } from '../realtime/realtime.constants';
import { parseTrustProxy } from './trust-proxy.config';
import {
  PASSWORD_POLICY_MESSAGE,
  isValidPassword,
} from '../common/validators/password.validator';

type Environment = Record<string, unknown>;

const durationPattern = /^\d+[smhd]$/;
const urlPattern = /^https?:\/\//i;
const emailAddressPattern = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function isValidMailbox(value: string): boolean {
  if (emailAddressPattern.test(value)) return true;
  const namedMailbox = /^(?:"[^"\r\n]+"|[^<>\r\n]+)\s*<([^<>\s]+)>$/.exec(value);
  return Boolean(namedMailbox && emailAddressPattern.test(namedMailbox[1]));
}

function valueOf(config: Environment, key: string): string {
  return String(config[key] ?? '').trim();
}

function requireKeys(config: Environment, keys: string[], errors: string[]): void {
  for (const key of keys) {
    if (!valueOf(config, key)) errors.push(`${key} is required`);
  }
}

function validateInteger(
  config: Environment,
  key: string,
  errors: string[],
  { min = 1, max = Number.MAX_SAFE_INTEGER }: { min?: number; max?: number } = {},
): void {
  const value = valueOf(config, key);
  if (!value) return;
  if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max) {
    errors.push(`${key} must be an integer between ${min} and ${max}`);
  }
}

function validateBoolean(config: Environment, key: string, errors: string[]): void {
  const value = valueOf(config, key);
  if (value && !['true', 'false'].includes(value.toLowerCase())) {
    errors.push(`${key} must be true or false`);
  }
}

export function validateEnvironment(config: Environment): Environment {
  const errors: string[] = [];
  const nodeEnv = valueOf(config, 'NODE_ENV') || 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) {
    errors.push('NODE_ENV must be development, test, or production');
  }

  requireKeys(
    config,
    ['MONGO_URI', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'],
    errors,
  );

  for (const key of ['JWT_ACCESS_EXPIRES_IN', 'JWT_REFRESH_EXPIRES_IN']) {
    const value = valueOf(config, key);
    if (!value || !durationPattern.test(value)) {
      errors.push(`${key} must look like 15m, 1h, or 7d`);
    }
  }

  errors.push(...parseTrustProxy(valueOf(config, 'TRUST_PROXY')).errors);
  if (nodeEnv === 'production' && !valueOf(config, 'TRUST_PROXY')) {
    // Unset would silently put every caller behind a proxy in one rate-limit
    // bucket, so production must state its topology explicitly.
    errors.push(
      'TRUST_PROXY is required in production: list the proxy IPs/CIDRs allowed to set X-Forwarded-For (for example the admin dashboard host), or set false only when clients connect directly',
    );
  }

  validateInteger(config, 'SHUTDOWN_DRAIN_MS', errors, { min: 0, max: 120_000 });
  validateInteger(config, 'SHUTDOWN_TIMEOUT_MS', errors, { min: 1_000, max: 300_000 });
  if (
    valueOf(config, 'SHUTDOWN_DRAIN_MS') &&
    valueOf(config, 'SHUTDOWN_TIMEOUT_MS') &&
    Number(valueOf(config, 'SHUTDOWN_DRAIN_MS')) >= Number(valueOf(config, 'SHUTDOWN_TIMEOUT_MS'))
  ) {
    errors.push('SHUTDOWN_DRAIN_MS must be smaller than SHUTDOWN_TIMEOUT_MS');
  }

  validateInteger(config, 'UPLOAD_MAX_INFLIGHT_BYTES', errors, { min: 1024 * 1024 });
  validateInteger(config, 'UPLOAD_MAX_CONCURRENT_PER_USER', errors, { min: 1, max: 20 });

  validateBoolean(config, 'CLEANUP_WORKER_ENABLED', errors);
  validateInteger(config, 'CLEANUP_INTERVAL_SECONDS', errors, { min: 30, max: 86_400 });
  validateInteger(config, 'CLEANUP_BATCH_SIZE', errors, { min: 1, max: 100 });
  validateInteger(config, 'CLEANUP_ALERT_AGE_SECONDS', errors, { min: 60 });

  validateBoolean(config, 'AUCTION_LIFECYCLE_WORKER_ENABLED', errors);
  validateInteger(config, 'AUCTION_LIFECYCLE_INTERVAL_SECONDS', errors, { min: 5, max: 86_400 });
  validateInteger(config, 'AUCTION_LIFECYCLE_BATCH_SIZE', errors, { min: 1, max: 200 });

  validateBoolean(config, 'AUCTION_FINALIZATION_WORKER_ENABLED', errors);
  validateInteger(config, 'AUCTION_FINALIZATION_INTERVAL_SECONDS', errors, { min: 5, max: 86_400 });
  validateInteger(config, 'AUCTION_FINALIZATION_BATCH_SIZE', errors, { min: 1, max: 200 });

  validateBoolean(config, 'OUTBOX_DISPATCHER_ENABLED', errors);
  validateInteger(config, 'OUTBOX_DISPATCHER_INTERVAL_SECONDS', errors, { min: 1, max: 3_600 });
  validateInteger(config, 'OUTBOX_DISPATCHER_BATCH_SIZE', errors, { min: 1, max: 500 });
  validateInteger(config, 'OUTBOX_LEASE_SECONDS', errors, { min: 10, max: 3_600 });
  validateInteger(config, 'OUTBOX_CONSUMER_TIMEOUT_SECONDS', errors, { min: 1, max: 300 });
  validateInteger(config, 'OUTBOX_MAX_ATTEMPTS', errors, { min: 1, max: 100 });
  validateInteger(config, 'OUTBOX_RETRY_BASE_SECONDS', errors, { min: 1, max: 3_600 });
  validateInteger(config, 'OUTBOX_RETRY_MAX_SECONDS', errors, { min: 1, max: 86_400 });
  // A live delivery must never outlive its own claim, or a second instance could deliver the same event concurrently.
  const outboxLease = valueOf(config, 'OUTBOX_LEASE_SECONDS');
  const outboxTimeout = valueOf(config, 'OUTBOX_CONSUMER_TIMEOUT_SECONDS');
  if (outboxLease && outboxTimeout && /^\d+$/.test(outboxLease) && /^\d+$/.test(outboxTimeout) && Number(outboxTimeout) * 2 > Number(outboxLease)) {
    errors.push('OUTBOX_CONSUMER_TIMEOUT_SECONDS must be at most half of OUTBOX_LEASE_SECONDS');
  }
  const outboxRetryBase = valueOf(config, 'OUTBOX_RETRY_BASE_SECONDS');
  const outboxRetryMax = valueOf(config, 'OUTBOX_RETRY_MAX_SECONDS');
  if (outboxRetryBase && outboxRetryMax && /^\d+$/.test(outboxRetryBase) && /^\d+$/.test(outboxRetryMax) && Number(outboxRetryBase) > Number(outboxRetryMax)) {
    errors.push('OUTBOX_RETRY_BASE_SECONDS must not exceed OUTBOX_RETRY_MAX_SECONDS');
  }

  // MAZAD-032 realtime. Opt-in: enabling it both accepts sockets AND makes this process the sole claimant of the outbox `realtime` consumer.
  validateBoolean(config, 'REALTIME_ENABLED', errors);
  validateInteger(config, 'REALTIME_MAX_CONNECTIONS', errors, { min: 1, max: 100_000 });
  validateInteger(config, 'REALTIME_MAX_CONNECTIONS_PER_IP', errors, { min: 1, max: 10_000 });
  validateInteger(config, 'REALTIME_MAX_SUBSCRIPTIONS_PER_SOCKET', errors, { min: 1, max: 500 });
  validateInteger(config, 'REALTIME_MAX_MESSAGE_BYTES', errors, { min: 128, max: REALTIME_MAX_MESSAGE_BYTES_HARD_CAP });
  validateInteger(config, 'REALTIME_MESSAGE_RATE_LIMIT', errors, { min: 1, max: 1_000 });
  validateInteger(config, 'REALTIME_MESSAGE_RATE_WINDOW_SECONDS', errors, { min: 1, max: 300 });
  validateInteger(config, 'REALTIME_HEARTBEAT_SECONDS', errors, { min: 5, max: 300 });
  validateInteger(config, 'REALTIME_MAX_BUFFERED_BYTES', errors, { min: 16_384, max: 67_108_864 });
  const realtimeTopology = valueOf(config, 'REALTIME_TOPOLOGY');
  if (realtimeTopology && realtimeTopology !== REALTIME_TOPOLOGY_SINGLE_INSTANCE) {
    errors.push(`REALTIME_TOPOLOGY must be ${REALTIME_TOPOLOGY_SINGLE_INSTANCE} (no shared fan-out adapter exists yet)`);
  }
  if (nodeEnv === 'production' && valueOf(config, 'REALTIME_ENABLED').toLowerCase() === 'true' && realtimeTopology !== REALTIME_TOPOLOGY_SINGLE_INSTANCE) {
    // The hub is per-process memory and the outbox gives each event to ONE claimant of `realtime`: with several realtime-enabled replicas,
    // clients connected to the others silently miss events. Production must state that exactly one instance serves realtime.
    errors.push(
      `REALTIME_TOPOLOGY=${REALTIME_TOPOLOGY_SINGLE_INSTANCE} is required in production when REALTIME_ENABLED=true: exactly one backend instance may serve realtime (set REALTIME_ENABLED=false on every other replica)`,
    );
  }

  const resetSecret = valueOf(config, 'JWT_RESET_SECRET');
  if (resetSecret) {
    if (nodeEnv === 'production' && resetSecret.length < 32) {
      errors.push('JWT_RESET_SECRET must be at least 32 characters in production');
    }
    if (
      resetSecret === valueOf(config, 'JWT_ACCESS_SECRET') ||
      resetSecret === valueOf(config, 'JWT_REFRESH_SECRET')
    ) {
      errors.push('JWT_RESET_SECRET must differ from the access and refresh secrets');
    }
  }

  const smtpKeys = [
    'MAIL_HOST',
    'MAIL_PORT',
    'MAIL_SECURE',
    'MAIL_USER',
    'MAIL_PASS',
    'MAIL_FROM',
    'MAIL_TLS_REJECT_UNAUTHORIZED',
  ];
  const smtpConfigured = smtpKeys.some((key) => Boolean(valueOf(config, key)));
  if (smtpConfigured || nodeEnv === 'production') requireKeys(config, smtpKeys, errors);
  const mailPort = valueOf(config, 'MAIL_PORT');
  if (
    mailPort &&
    (!/^\d+$/.test(mailPort) || Number(mailPort) < 1 || Number(mailPort) > 65535)
  ) {
    errors.push('MAIL_PORT must be a valid TCP port');
  }
  validateBoolean(config, 'MAIL_SECURE', errors);
  validateBoolean(config, 'MAIL_TLS_REJECT_UNAUTHORIZED', errors);
  const mailFrom = valueOf(config, 'MAIL_FROM');
  if (mailFrom && !isValidMailbox(mailFrom)) {
    errors.push('MAIL_FROM must be an email address or a named mailbox');
  }
  if (
    nodeEnv === 'production' &&
    valueOf(config, 'MAIL_TLS_REJECT_UNAUTHORIZED').toLowerCase() === 'false'
  ) {
    errors.push('MAIL_TLS_REJECT_UNAUTHORIZED cannot be false in production');
  }

  const cloudinaryKeys = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
  ];
  const cloudinaryConfigured = cloudinaryKeys.some((key) => Boolean(valueOf(config, key)));
  if (cloudinaryConfigured || nodeEnv === 'production') requireKeys(config, cloudinaryKeys, errors);

  const adminKeys = ['ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ADMIN_FULL_NAME'];
  const adminConfigured = adminKeys.some(
    (key) => config[key] !== undefined && String(config[key]).length > 0,
  );
  const adminPassword =
    config.ADMIN_PASSWORD === undefined || config.ADMIN_PASSWORD === null
      ? ''
      : String(config.ADMIN_PASSWORD);
  if (adminConfigured) {
    requireKeys(config, ['ADMIN_EMAIL', 'ADMIN_FULL_NAME'], errors);
    if (!adminPassword) errors.push('ADMIN_PASSWORD is required');
  }
  const adminEmail = valueOf(config, 'ADMIN_EMAIL');
  if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) {
    errors.push('ADMIN_EMAIL must be a valid email address');
  }
  if (adminPassword && !isValidPassword(adminPassword)) {
    errors.push(`ADMIN_PASSWORD is invalid: ${PASSWORD_POLICY_MESSAGE}`);
  }

  for (const key of ['OTP_EXPIRES_MINUTES', 'OTP_RESEND_SECONDS']) {
    const value = valueOf(config, key);
    if (value && (!/^\d+$/.test(value) || Number(value) < 1)) {
      errors.push(`${key} must be a positive integer`);
    }
  }

  const geocodingBaseUrl = valueOf(config, 'GEOCODING_PROVIDER_BASE_URL');
  if (geocodingBaseUrl && !urlPattern.test(geocodingBaseUrl)) {
    errors.push('GEOCODING_PROVIDER_BASE_URL must be an HTTP(S) URL');
  }

  const geocodingProvider = valueOf(config, 'GEOCODING_PROVIDER').toLowerCase();
  if (geocodingProvider && !['nominatim', 'google', 'disabled'].includes(geocodingProvider)) {
    errors.push('GEOCODING_PROVIDER must be nominatim, google or disabled');
  }
  if (geocodingProvider === 'google' && !valueOf(config, 'GOOGLE_MAPS_SERVER_API_KEY')) {
    errors.push('GOOGLE_MAPS_SERVER_API_KEY is required when GEOCODING_PROVIDER=google');
  }
  const usesNominatim = !geocodingProvider || geocodingProvider === 'nominatim';
  validateBoolean(config, 'GEOCODING_ALLOW_PUBLIC_PROVIDER', errors);
  validateInteger(config, 'GEOCODING_MIN_INTERVAL_MS', errors, { min: 0 });
  validateInteger(config, 'GEOCODING_MAX_CONCURRENCY', errors, { min: 1, max: 64 });
  validateInteger(config, 'GEOCODING_MAX_QUEUE', errors, { min: 1, max: 1000 });
  validateInteger(config, 'GEOCODING_QUEUE_TIMEOUT_MS', errors, { min: 1 });
  validateInteger(config, 'GEOCODING_CACHE_MAX_ENTRIES', errors, { min: 1, max: 100_000 });

  if (nodeEnv === 'production') {
    if (
      usesNominatim &&
      isPublicOsmNominatim(valueOf(config, 'GEOCODING_PROVIDER_BASE_URL')) &&
      valueOf(config, 'GEOCODING_ALLOW_PUBLIC_PROVIDER').toLowerCase() !== 'true'
    ) {
      errors.push(
        'GEOCODING_PROVIDER_BASE_URL must point to a self-hosted or commercial geocoder in production (the public OpenStreetMap Nominatim service forbids production use); set GEOCODING_ALLOW_PUBLIC_PROVIDER=true only as a temporary, explicit override',
      );
    }
    if (usesNominatim && !valueOf(config, 'GEOCODING_USER_AGENT')) {
      errors.push('GEOCODING_USER_AGENT is required in production');
    }
    const origins = valueOf(config, 'CORS_ORIGINS');
    if (!origins) errors.push('CORS_ORIGINS is required in production');
    for (const origin of origins
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)) {
      if (!urlPattern.test(origin)) errors.push(`Invalid CORS origin: ${origin}`);
    }
    if (valueOf(config, 'JWT_ACCESS_SECRET').length < 32) {
      errors.push('JWT_ACCESS_SECRET must be at least 32 characters in production');
    }
    if (valueOf(config, 'JWT_REFRESH_SECRET').length < 32) {
      errors.push('JWT_REFRESH_SECRET must be at least 32 characters in production');
    }
  }

  if (errors.length) throw new Error(`Invalid environment configuration:\n- ${errors.join('\n- ')}`);
  return { ...config, NODE_ENV: nodeEnv };
}
