import { CanActivate, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { assertActionAllowed, isProtectedProcess, requireDeploymentEnv } from '../../config/deployment-environment';
import { AUCTION_PAYMENT_PROVIDER_PORT, AuctionPaymentProviderPort } from '../auction-payment-provider.port';
import { FakePaymentProvider } from '../fake-payment-provider';

/**
 * Makes the development fake-payment routes NOT EXIST unless this process is a
 * local/development one that actually runs the FakePaymentProvider. Third,
 * independent layer behind environment validation and the provider factory
 * (which both already refuse `PAYMENT_PROVIDER=fake` in staging/production):
 *
 *  1. the bound provider port must BE a `FakePaymentProvider` instance — with
 *     the fail-closed default, or any future real adapter, the route is absent;
 *  2. the process must not be a protected (staging/production) one;
 *  3. the `fake-payments` action of the deployment decision table must allow it.
 *
 * Every refusal is a plain 404, before authentication: outside development the
 * route is indistinguishable from one that was never registered.
 */
@Injectable()
export class FakePaymentsDevGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService,
    @Inject(AUCTION_PAYMENT_PROVIDER_PORT) private readonly provider: AuctionPaymentProviderPort,
  ) {}

  canActivate(): boolean {
    if (!fakePaymentsDevRoutesAllowed(this.provider, { NODE_ENV: this.config.get('NODE_ENV'), DEPLOYMENT_ENV: this.config.get('DEPLOYMENT_ENV') })) {
      throw new NotFoundException();
    }
    return true;
  }
}

export function fakePaymentsDevRoutesAllowed(provider: AuctionPaymentProviderPort, env: Record<string, unknown>): boolean {
  if (!(provider instanceof FakePaymentProvider)) return false;
  if (isProtectedProcess(env)) return false;
  try {
    assertActionAllowed('fake-payments', requireDeploymentEnv(env), env);
    return true;
  } catch {
    return false;
  }
}
