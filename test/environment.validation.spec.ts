import { validateEnvironment } from '../src/config/environment.validation';
import { buildCorsOptions } from '../src/config/cors.config';

const validDevelopment = {
  NODE_ENV: 'development',
  MONGO_URI: 'mongodb://localhost:27017/mazadak_test',
  JWT_ACCESS_SECRET: 'development-access-secret',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_SECRET: 'development-refresh-secret',
  JWT_REFRESH_EXPIRES_IN: '7d',
};

describe('environment validation', () => {
  it('allows documented optional integrations to be absent in development', () => {
    expect(validateEnvironment(validDevelopment)).toMatchObject({ NODE_ENV: 'development' });
  });

  it('rejects a partial SMTP configuration', () => {
    expect(() => validateEnvironment({ ...validDevelopment, MAIL_HOST: 'smtp.example.test' })).toThrow(
      'MAIL_PORT is required',
    );
  });

  it('requires secure complete infrastructure configuration in production', () => {
    expect(() =>
      validateEnvironment({
        ...validDevelopment,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: 'a'.repeat(32),
        JWT_REFRESH_SECRET: 'b'.repeat(32),
        MAIL_TLS_REJECT_UNAUTHORIZED: 'false',
      }),
    ).toThrow('MAIL_TLS_REJECT_UNAUTHORIZED cannot be false in production');
  });

  it('validates admin seed variables as one complete set', () => {
    expect(() => validateEnvironment({ ...validDevelopment, ADMIN_EMAIL: 'admin@example.test' })).toThrow(
      'ADMIN_PASSWORD is required',
    );
  });

  it.each(['12345678', 'abcdefgh', 'password', 'ABCDEFGH', 'abc12345'])(
    'accepts ADMIN_PASSWORD=%s using the shared application policy',
    (password) => {
      expect(
        validateEnvironment({
          ...validDevelopment,
          ADMIN_EMAIL: 'admin@example.test',
          ADMIN_PASSWORD: password,
          ADMIN_FULL_NAME: 'Development Admin',
        }),
      ).toMatchObject({ ADMIN_PASSWORD: password });
    },
  );

  it('rejects a seven-character ADMIN_PASSWORD', () => {
    expect(() =>
      validateEnvironment({
        ...validDevelopment,
        ADMIN_EMAIL: 'admin@example.test',
        ADMIN_PASSWORD: '1234567',
        ADMIN_FULL_NAME: 'Development Admin',
      }),
    ).toThrow('ADMIN_PASSWORD is invalid');
  });

  it('restricts production CORS to the configured allowlist', () => {
    const options = buildCorsOptions({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://admin.example.com,https://app.example.com',
    });
    expect(options.origin).toEqual([
      'https://admin.example.com',
      'https://app.example.com',
    ]);
  });

  describe('Phase 1 operational settings', () => {
    const invalid = (extra: Record<string, string>) => () => validateEnvironment({ ...validDevelopment, ...extra });

    it('validates shutdown timing', () => {
      expect(invalid({ SHUTDOWN_DRAIN_MS: '5000', SHUTDOWN_TIMEOUT_MS: '25000' })).not.toThrow();
      expect(invalid({ SHUTDOWN_DRAIN_MS: 'soon' })).toThrow('SHUTDOWN_DRAIN_MS');
      expect(invalid({ SHUTDOWN_DRAIN_MS: '30000', SHUTDOWN_TIMEOUT_MS: '20000' })).toThrow('smaller than SHUTDOWN_TIMEOUT_MS');
    });

    it('validates upload budgets', () => {
      expect(invalid({ UPLOAD_MAX_INFLIGHT_BYTES: '268435456', UPLOAD_MAX_CONCURRENT_PER_USER: '3' })).not.toThrow();
      expect(invalid({ UPLOAD_MAX_CONCURRENT_PER_USER: '0' })).toThrow('UPLOAD_MAX_CONCURRENT_PER_USER');
      expect(invalid({ UPLOAD_MAX_INFLIGHT_BYTES: '12' })).toThrow('UPLOAD_MAX_INFLIGHT_BYTES');
    });

    it('validates the cleanup worker settings', () => {
      expect(invalid({ CLEANUP_WORKER_ENABLED: 'true', CLEANUP_INTERVAL_SECONDS: '300', CLEANUP_BATCH_SIZE: '50' })).not.toThrow();
      expect(invalid({ CLEANUP_WORKER_ENABLED: 'yes' })).toThrow('CLEANUP_WORKER_ENABLED');
      expect(invalid({ CLEANUP_INTERVAL_SECONDS: '5' })).toThrow('CLEANUP_INTERVAL_SECONDS');
      expect(invalid({ CLEANUP_BATCH_SIZE: '1000' })).toThrow('CLEANUP_BATCH_SIZE');
    });

    it('validates the auction lifecycle worker settings (MAZAD-024)', () => {
      expect(invalid({ AUCTION_LIFECYCLE_WORKER_ENABLED: 'true', AUCTION_LIFECYCLE_INTERVAL_SECONDS: '30', AUCTION_LIFECYCLE_BATCH_SIZE: '50' })).not.toThrow();
      expect(invalid({ AUCTION_LIFECYCLE_WORKER_ENABLED: 'yes' })).toThrow('AUCTION_LIFECYCLE_WORKER_ENABLED');
      expect(invalid({ AUCTION_LIFECYCLE_INTERVAL_SECONDS: '1' })).toThrow('AUCTION_LIFECYCLE_INTERVAL_SECONDS');
      expect(invalid({ AUCTION_LIFECYCLE_BATCH_SIZE: '1000' })).toThrow('AUCTION_LIFECYCLE_BATCH_SIZE');
    });

    it('validates the auction finalization worker settings (MAZAD-030)', () => {
      expect(invalid({ AUCTION_FINALIZATION_WORKER_ENABLED: 'true', AUCTION_FINALIZATION_INTERVAL_SECONDS: '30', AUCTION_FINALIZATION_BATCH_SIZE: '50' })).not.toThrow();
      expect(invalid({ AUCTION_FINALIZATION_WORKER_ENABLED: 'yes' })).toThrow('AUCTION_FINALIZATION_WORKER_ENABLED');
      expect(invalid({ AUCTION_FINALIZATION_INTERVAL_SECONDS: '1' })).toThrow('AUCTION_FINALIZATION_INTERVAL_SECONDS');
      expect(invalid({ AUCTION_FINALIZATION_BATCH_SIZE: '1000' })).toThrow('AUCTION_FINALIZATION_BATCH_SIZE');
    });
  });
});
