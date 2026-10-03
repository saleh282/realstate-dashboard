import { ConfigService } from '@nestjs/config';
import { EnvironmentSafetyError, isProtectedProcess } from '../config/deployment-environment';
import { PaymentProviderPort, UnconfiguredPaymentProvider } from './payment-provider.port';
import { FakePaymentProvider } from './fake-payment-provider';
import { fakeDefaultScenario, paymentProviderName } from './payment-provider.config';

/**
 * Builds the payment provider port. Second, independent layer behind the
 * environment validation: even if validation were bypassed, a protected
 * deployment can never receive the fake provider.
 */
export function buildPaymentProvider(env: Record<string, unknown>): PaymentProviderPort {
  if (paymentProviderName(env) !== 'fake') return new UnconfiguredPaymentProvider();
  if (isProtectedProcess(env)) throw new EnvironmentSafetyError('PAYMENT_PROVIDER=fake is forbidden in staging and production');
  return new FakePaymentProvider(fakeDefaultScenario(env));
}

export function paymentProviderPortFactory(config: ConfigService): PaymentProviderPort {
  return buildPaymentProvider({
    NODE_ENV: config.get('NODE_ENV'),
    DEPLOYMENT_ENV: config.get('DEPLOYMENT_ENV'),
    PAYMENT_PROVIDER: config.get('PAYMENT_PROVIDER'),
    FAKE_PAYMENT_SCENARIO: config.get('FAKE_PAYMENT_SCENARIO'),
  });
}
