'use strict';
const {
  assertActionAllowed,
  isProtectedProcess,
  requireDeploymentEnv,
} = require('../../../config/deployment-environment');
const { FakePaymentProvider } = require('../fake-payment-provider');
function fakePaymentsDevRoutesAllowed(provider, env) {
  if (!(provider instanceof FakePaymentProvider) || isProtectedProcess(env)) return false;
  try {
    assertActionAllowed('fake-payments', requireDeploymentEnv(env), env);
    return true;
  } catch {
    return false;
  }
}
module.exports = { fakePaymentsDevRoutesAllowed };
