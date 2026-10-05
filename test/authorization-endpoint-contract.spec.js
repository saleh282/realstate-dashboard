'use strict';
// Compare real Express middleware to the pre-migration access contract.
const expected = require('./fixtures/express-route-contract.json');
jest.mock('../src/middleware/auth', () => {
  const guard = (name, values = []) =>
    Object.assign((req, res, next) => next(), { guard: name, values });
  return {
    authenticate: () => guard('JwtAuthGuard'),
    requireRoles: (...v) => guard('RolesGuard', v),
    requireCapabilities: (...v) => guard('CapabilityGuard', v),
    fakePaymentsOnly: () => guard('FakePaymentsDevGuard'),
  };
});
const express = require('express');
const { registerRoutes } = require('../src/routes');
const { Capability } = require('../src/domain/authorization/capability');
const { SystemRole } = require('../src/domain/auth/roles.enum');
it('preserves all 153 endpoints, guard ordering, roles and capabilities', () => {
  const app = express();
  const mounts = [];
  const mount = app.use.bind(app);
  app.use = (prefix, router) => {
    mounts.push({ prefix, router });
    return mount(prefix, router);
  };
  registerRoutes(app, {});
  const actual = mounts.flatMap(({ prefix, router }) =>
    router.stack.filter((layer) => layer.route).map(({ route }) => ({ prefix, route })),
  );
  expect(actual).toHaveLength(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const { prefix, route } = actual[i];
    const contract = expected[i];
    expect(route.methods[contract.method.toLowerCase()]).toBe(true);
    expect(prefix + (route.path === '/' ? '' : route.path)).toBe(contract.path);
    const guards = route.stack.map((l) => l.handle).filter((h) => h.guard);
    expect(guards.map((h) => h.guard)).toEqual(contract.guards);
    const resolve = (v) =>
      v.startsWith('Capability.') ? Capability[v.split('.')[1]] : SystemRole[v.split('.')[1]];
    if (contract.guards.includes('CapabilityGuard'))
      expect(guards.find((h) => h.guard === 'CapabilityGuard').values).toEqual(
        contract.capabilities.map(resolve),
      );
    if (contract.guards.includes('RolesGuard'))
      expect(guards.find((h) => h.guard === 'RolesGuard').values).toEqual(
        contract.roles.map(resolve),
      );
  }
});
