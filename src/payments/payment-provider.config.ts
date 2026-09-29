import { isProtectedProcess } from '../config/deployment-environment';

/**
 * Which implementation backs the payment provider port.
 *  - `none` (default): fail closed. Payment-dependent features answer PROVIDER_UNAVAILABLE.
 *  - `fake`: deterministic in-process provider for local/development/test only.
 * A real gateway adapter is deliberately not selectable yet.
 */
export const PAYMENT_PROVIDERS = ['none', 'fake'] as const;
export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export const FAKE_PAYMENT_SCENARIOS = ['success', 'failed', 'pending', 'error'] as const;
export type FakePaymentScenario = (typeof FAKE_PAYMENT_SCENARIOS)[number];

type Env = Record<string, unknown>;
const text = (env: Env, key: string) => String(env[key] ?? '').trim().toLowerCase();

export function paymentProviderName(env: Env): PaymentProviderName {
  const value = text(env, 'PAYMENT_PROVIDER') || 'none';
  return (PAYMENT_PROVIDERS as readonly string[]).includes(value) ? (value as PaymentProviderName) : 'none';
}

export function paymentProviderErrors(env: Env): string[] {
  const errors: string[] = [];
  const raw = text(env, 'PAYMENT_PROVIDER');
  if (raw && !(PAYMENT_PROVIDERS as readonly string[]).includes(raw)) {
    errors.push(`PAYMENT_PROVIDER must be one of ${PAYMENT_PROVIDERS.join(', ')} (no real gateway adapter exists yet)`);
  }
  if (raw === 'fake' && isProtectedProcess(env)) {
    errors.push('PAYMENT_PROVIDER=fake is forbidden in staging and production');
  }
  const scenario = text(env, 'FAKE_PAYMENT_SCENARIO');
  if (scenario && !(FAKE_PAYMENT_SCENARIOS as readonly string[]).includes(scenario)) {
    errors.push(`FAKE_PAYMENT_SCENARIO must be one of ${FAKE_PAYMENT_SCENARIOS.join(', ')}`);
  }
  if (scenario && raw !== 'fake') errors.push('FAKE_PAYMENT_SCENARIO requires PAYMENT_PROVIDER=fake');
  return errors;
}

export function fakeDefaultScenario(env: Env): FakePaymentScenario {
  const value = text(env, 'FAKE_PAYMENT_SCENARIO');
  return (FAKE_PAYMENT_SCENARIOS as readonly string[]).includes(value) ? (value as FakePaymentScenario) : 'success';
}
