import { ServiceUnavailableException } from '@nestjs/common';
import { UnconfiguredPaymentProvider } from '../src/payments/auction-payment-provider.port';
import { FakePaymentProvider } from '../src/payments/fake-payment-provider';
import { buildPaymentProvider, paymentProviderPortFactory } from '../src/payments/payment-provider.factory';
import { paymentProviderErrors, paymentProviderName } from '../src/payments/payment-provider.config';
import { decideOutcome } from '../src/payments/payment-verification';
import { PaymentPurpose } from '../src/payments/payment.types';
import { validateEnvironment } from '../src/config/environment.validation';

const request = (overrides: Record<string, unknown> = {}) => ({ purpose: PaymentPurpose.AUCTION_ENTRY, paymentId: 'p1', amountMinor: 50_000, currency: 'EGP', ...overrides });

describe('FakePaymentProvider (deterministic, non-production)', () => {
  it('implements the unchanged port: key, configured flag, initiate and verify', async () => {
    const provider = new FakePaymentProvider();
    expect(provider.providerKey).toBe('fake');
    expect(provider.configured).toBe(true);
    const { providerReference, clientHandoff } = await provider.initiate(request());
    expect(providerReference).toMatch(/^fake~success~50000~EGP~p1~/);
    expect(clientHandoff).toContain(providerReference);
    await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'SUCCEEDED', providerReference, amountMinor: 50_000, currency: 'EGP' });
  });

  it('a success outcome passes the shared server-side verification rules; a tampered amount does not', async () => {
    const provider = new FakePaymentProvider();
    const { providerReference } = await provider.initiate(request());
    const outcome = await provider.verify(providerReference);
    expect(decideOutcome({ providerReference, amountMinor: 50_000, currency: 'EGP' }, outcome)).toEqual({ kind: 'SUCCEEDED' });
    expect(decideOutcome({ providerReference, amountMinor: 60_000, currency: 'EGP' }, outcome)).toMatchObject({ kind: 'MISMATCH' });
  });

  it('runs each scenario deterministically: failed, pending, error', async () => {
    const provider = new FakePaymentProvider();
    provider.enqueue('failed', 'pending', 'error');
    const failed = await provider.initiate(request());
    await expect(provider.verify(failed.providerReference)).resolves.toMatchObject({ status: 'FAILED', failureCode: 'FAKE_DECLINED' });
    const pending = await provider.initiate(request({ paymentId: 'p2' }));
    await expect(provider.verify(pending.providerReference)).resolves.toMatchObject({ status: 'PENDING' });
    await expect(provider.initiate(request({ paymentId: 'p3' }))).rejects.toBeInstanceOf(ServiceUnavailableException);
    // The queue is drained: the default scenario applies again.
    expect((await provider.initiate(request({ paymentId: 'p4' }))).providerReference).toContain('~success~');
  });

  it('a pending payment stays pending until explicitly settled, then reconciles to the settled outcome', async () => {
    const provider = new FakePaymentProvider('pending');
    const { providerReference } = await provider.initiate(request());
    await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'PENDING' });
    await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'PENDING' });
    provider.settle(providerReference, 'success');
    await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    const other = await provider.initiate(request({ paymentId: 'p2' }));
    provider.settle(other.providerReference, 'failed');
    await expect(provider.verify(other.providerReference)).resolves.toMatchObject({ status: 'FAILED' });
  });

  it('simulates a gateway outage during verification without losing the payment', async () => {
    const provider = new FakePaymentProvider();
    const { providerReference } = await provider.initiate(request());
    provider.failNextVerifications(2);
    await expect(provider.verify(providerReference)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(provider.verify(providerReference)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('is stateless across a restart: a fresh instance verifies a reference issued by another', async () => {
    const reference = (await new FakePaymentProvider().initiate(request({ purpose: PaymentPurpose.MANAGED_MARKETING, amountMinor: 1234 }))).providerReference;
    await expect(new FakePaymentProvider().verify(reference)).resolves.toMatchObject({ status: 'SUCCEEDED', amountMinor: 1234 });
  });

  it('the scenario never depends on the amount or any caller-controlled field', async () => {
    const provider = new FakePaymentProvider('failed');
    for (const amountMinor of [1, 999, 12_345, 100_00]) {
      expect((await provider.initiate(request({ amountMinor }))).providerReference).toContain('~failed~');
    }
  });

  it('refuses references it did not issue, and never returns raw payloads or credentials', async () => {
    const provider = new FakePaymentProvider();
    for (const bad of ['', 'real~success~1~EGP', 'fake~success~NaN~EGP~p', 'gateway-ref-123']) {
      await expect(provider.verify(bad)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    const outcome = await provider.verify((await provider.initiate(request())).providerReference);
    expect(Object.keys(outcome).sort()).toEqual(['amountMinor', 'currency', 'providerEventId', 'providerReference', 'status']);
  });

  it('supports both payment purposes through the same port', async () => {
    const provider = new FakePaymentProvider();
    for (const purpose of Object.values(PaymentPurpose)) {
      const { providerReference } = await provider.initiate(request({ purpose }));
      await expect(provider.verify(providerReference)).resolves.toMatchObject({ status: 'SUCCEEDED' });
    }
  });
});

describe('payment provider selection is fail-closed and impossible to enable in protected deployments', () => {
  const dev = { NODE_ENV: 'development' };
  const prod = { NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' };
  const staging = { NODE_ENV: 'production', DEPLOYMENT_ENV: 'staging' };

  it('defaults to the fail-closed provider everywhere, including development', async () => {
    for (const env of [{}, dev, prod, staging, { ...prod, PAYMENT_PROVIDER: 'none' }]) {
      const provider = buildPaymentProvider(env);
      expect(provider).toBeInstanceOf(UnconfiguredPaymentProvider);
      expect(provider.configured).toBe(false);
      await expect(provider.initiate(request())).rejects.toMatchObject({ response: { code: 'PAYMENT_PROVIDER_UNAVAILABLE' } });
    }
  });

  it('builds the fake provider only for local and development, honouring the scenario default', () => {
    expect(buildPaymentProvider({ NODE_ENV: 'test', PAYMENT_PROVIDER: 'fake' })).toBeInstanceOf(FakePaymentProvider);
    expect(buildPaymentProvider({ ...dev, PAYMENT_PROVIDER: 'fake', DEPLOYMENT_ENV: 'local' })).toBeInstanceOf(FakePaymentProvider);
    const failing = buildPaymentProvider({ ...dev, PAYMENT_PROVIDER: 'fake', FAKE_PAYMENT_SCENARIO: 'failed' }) as FakePaymentProvider;
    return expect(failing.initiate(request())).resolves.toMatchObject({ providerReference: expect.stringContaining('~failed~') });
  });

  it.each([
    ['production', prod], ['staging', staging],
    ['NODE_ENV=production without DEPLOYMENT_ENV', { NODE_ENV: 'production' }],
    ['unresolvable deployment', { NODE_ENV: 'development', DEPLOYMENT_ENV: 'weird' }],
    ['a development NODE_ENV that claims production', { NODE_ENV: 'development', DEPLOYMENT_ENV: 'production' }],
  ])('the factory throws for PAYMENT_PROVIDER=fake in %s', (_name, env) => {
    expect(() => buildPaymentProvider({ ...env, PAYMENT_PROVIDER: 'fake' })).toThrow('forbidden in staging and production');
    expect(() => buildPaymentProvider({ ...env, PAYMENT_PROVIDER: ' FAKE ' })).toThrow('forbidden');
  });

  it('environment validation rejects the fake provider (and its scenario switch) in protected deployments', () => {
    expect(paymentProviderErrors({ ...prod, PAYMENT_PROVIDER: 'fake' })).toContain('PAYMENT_PROVIDER=fake is forbidden in staging and production');
    expect(paymentProviderErrors({ ...staging, PAYMENT_PROVIDER: 'fake' })).toHaveLength(1);
    expect(paymentProviderErrors({ ...dev, PAYMENT_PROVIDER: 'fake' })).toEqual([]);
    expect(paymentProviderErrors({ ...dev, PAYMENT_PROVIDER: 'paymob' })[0]).toContain('must be one of none, fake');
    expect(paymentProviderErrors({ ...dev, FAKE_PAYMENT_SCENARIO: 'success' })[0]).toContain('requires PAYMENT_PROVIDER=fake');
    expect(paymentProviderErrors({ ...dev, PAYMENT_PROVIDER: 'fake', FAKE_PAYMENT_SCENARIO: 'chaos' })[0]).toContain('must be one of');
    expect(paymentProviderName({ PAYMENT_PROVIDER: 'fake' })).toBe('fake');
    expect(paymentProviderName({ PAYMENT_PROVIDER: 'unknown' })).toBe('none');
  });

  it('a full production configuration with the fake provider fails startup validation', () => {
    const production = {
      MONGO_URI: 'mongodb://db.prod.example/mazad', JWT_ACCESS_SECRET: 'a'.repeat(40), JWT_REFRESH_SECRET: 'b'.repeat(40), JWT_ACCESS_EXPIRES_IN: '15m', JWT_REFRESH_EXPIRES_IN: '7d',
      NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', DB_ENV_ALLOWLIST: 'db.prod.example/mazad', TRUST_PROXY: 'false',
      MAIL_HOST: 'smtp.example.com', MAIL_PORT: '587', MAIL_SECURE: 'false', MAIL_USER: 'u', MAIL_PASS: 'p', MAIL_FROM: 'no-reply@example.com', MAIL_TLS_REJECT_UNAUTHORIZED: 'true',
      CLOUDINARY_CLOUD_NAME: 'c', CLOUDINARY_API_KEY: 'k', CLOUDINARY_API_SECRET: 's', CORS_ORIGINS: 'https://admin.example.com',
      GEOCODING_USER_AGENT: 'Mazad/1.0', GEOCODING_PROVIDER_BASE_URL: 'https://geocoder.example.com',
    };
    expect(() => validateEnvironment(production)).not.toThrow();
    expect(() => validateEnvironment({ ...production, PAYMENT_PROVIDER: 'fake' })).toThrow('PAYMENT_PROVIDER=fake is forbidden');
  });

  it('the Nest provider factory applies the same rule to the configuration service', () => {
    const config = (values: Record<string, string>) => ({ get: (key: string) => values[key] }) as any;
    expect(() => paymentProviderPortFactory(config({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production', PAYMENT_PROVIDER: 'fake' }))).toThrow('forbidden');
    expect(paymentProviderPortFactory(config({ NODE_ENV: 'production', DEPLOYMENT_ENV: 'production' }))).toBeInstanceOf(UnconfiguredPaymentProvider);
    expect(paymentProviderPortFactory(config({ NODE_ENV: 'development', PAYMENT_PROVIDER: 'fake' }))).toBeInstanceOf(FakePaymentProvider);
  });
});
