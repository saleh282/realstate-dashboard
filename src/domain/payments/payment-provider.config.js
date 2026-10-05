'use strict';

const { isProtectedProcess } = require('../../config/deployment-environment');
/**
 * Which implementation backs the payment provider port.
 *  - `none` (default): fail closed. Payment-dependent features answer PROVIDER_UNAVAILABLE.
 *  - `fake`: deterministic in-process provider for local/development/test only.
 * A real gateway adapter is deliberately not selectable yet.
 */
const PAYMENT_PROVIDERS = ['none', 'fake'];
const FAKE_PAYMENT_SCENARIOS = ['success', 'failed', 'pending', 'error'];
const text = (env, key) =>
  String(env[key] ?? '')
    .trim()
    .toLowerCase();
function paymentProviderName(env) {
  const value = text(env, 'PAYMENT_PROVIDER') || 'none';
  return PAYMENT_PROVIDERS.includes(value) ? value : 'none';
}
function paymentProviderErrors(env) {
  const errors = [];
  const raw = text(env, 'PAYMENT_PROVIDER');
  if (raw && !PAYMENT_PROVIDERS.includes(raw)) {
    errors.push(
      `PAYMENT_PROVIDER must be one of ${PAYMENT_PROVIDERS.join(', ')} (no real gateway adapter exists yet)`,
    );
  }
  if (raw === 'fake' && isProtectedProcess(env)) {
    errors.push('PAYMENT_PROVIDER=fake is forbidden in staging and production');
  }
  const scenario = text(env, 'FAKE_PAYMENT_SCENARIO');
  if (scenario && !FAKE_PAYMENT_SCENARIOS.includes(scenario)) {
    errors.push(`FAKE_PAYMENT_SCENARIO must be one of ${FAKE_PAYMENT_SCENARIOS.join(', ')}`);
  }
  if (scenario && raw !== 'fake')
    errors.push('FAKE_PAYMENT_SCENARIO requires PAYMENT_PROVIDER=fake');
  return errors;
}
function fakeDefaultScenario(env) {
  const value = text(env, 'FAKE_PAYMENT_SCENARIO');
  return FAKE_PAYMENT_SCENARIOS.includes(value) ? value : 'success';
}

Object.assign(exports, {
  PAYMENT_PROVIDERS,
  FAKE_PAYMENT_SCENARIOS,
  paymentProviderName,
  paymentProviderErrors,
  fakeDefaultScenario,
});
