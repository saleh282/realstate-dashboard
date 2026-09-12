import {
  PASSWORD_POLICY_MESSAGE,
  isValidPassword,
} from '../common/validators/password.validator';

type Environment = Record<string, unknown>;

const durationPattern = /^\d+[smhd]$/;
const urlPattern = /^https?:\/\//i;

function valueOf(config: Environment, key: string): string {
  return String(config[key] ?? '').trim();
}

function requireKeys(config: Environment, keys: string[], errors: string[]): void {
  for (const key of keys) {
    if (!valueOf(config, key)) errors.push(`${key} is required`);
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

  if (nodeEnv === 'production') {
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
