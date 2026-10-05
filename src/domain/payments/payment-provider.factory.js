'use strict';

const {
  EnvironmentSafetyError,
  isProtectedProcess,
} = require('../../config/deployment-environment');
const { UnconfiguredPaymentProvider } = require('./payment-provider.port');
const { FakePaymentProvider } = require('./fake-payment-provider');
const { fakeDefaultScenario, paymentProviderName } = require('./payment-provider.config');
/**
 * Builds the payment provider port. Second, independent layer behind the
 * environment validation: even if validation were bypassed, a protected
 * deployment can never receive the fake provider.
 */
function buildPaymentProvider(env) {
  if (paymentProviderName(env) !== 'fake') return new UnconfiguredPaymentProvider();
  if (isProtectedProcess(env))
    throw new EnvironmentSafetyError(
      'PAYMENT_PROVIDER=fake is forbidden in staging and production',
    );
  return new FakePaymentProvider(fakeDefaultScenario(env));
}
function paymentProviderPortFactory(config) {
  return buildPaymentProvider({
    NODE_ENV: config.get('NODE_ENV'),
    DEPLOYMENT_ENV: config.get('DEPLOYMENT_ENV'),
    PAYMENT_PROVIDER: config.get('PAYMENT_PROVIDER'),
    FAKE_PAYMENT_SCENARIO: config.get('FAKE_PAYMENT_SCENARIO'),
  });
}

Object.assign(exports, { buildPaymentProvider, paymentProviderPortFactory });
