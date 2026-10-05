'use strict';
require('dotenv/config');
const { createContext } = require('../config/database');
const { Logger } = require('../common/logging/logger');
const { ConfigService } = require('../config/config');
const { SystemRole } = require('../domain/auth/roles.enum');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../domain/users/identity.types');
const { hashPassword } = require('../common/security/password-hashing');
const { UsersService } = require('../services/users.service');
const { guardAction } = require('../config/deployment-environment');
async function seedAdmin() {
  const app = await createContext({ initialize: false });
  const config = app.services.ConfigService;
  const users = app.services.UsersService;
  try {
    await guardAction('seed:dev-admin', process.env, app.connection.db);
    const email = config.get('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = config.get('ADMIN_PASSWORD');
    const fullName = config.get('ADMIN_FULL_NAME')?.trim();
    if (!email || !password || !fullName) {
      throw new Error('ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_FULL_NAME are required');
    }
    const existing = await users.findByIdentifier(email);
    if (existing) {
      if (existing.systemRole === SystemRole.SUPER_ADMIN) {
        throw new Error('Refusing to demote SUPER_ADMIN through the admin seed');
      }
      let changed = false;
      if (existing.systemRole !== SystemRole.ADMIN) {
        existing.systemRole = SystemRole.ADMIN;
        changed = true;
      }
      if (!existing.emailVerifiedAt) {
        existing.emailVerifiedAt = new Date();
        changed = true;
      }
      if (!existing.accountType) {
        existing.accountType = AccountType.USER;
        changed = true;
      }
      if (existing.accountStatus !== AccountStatus.ACTIVE) {
        existing.accountStatus = AccountStatus.ACTIVE;
        changed = true;
      }
      if (!existing.brokerStatus) {
        existing.brokerStatus = BrokerStatus.NOT_APPLIED;
        changed = true;
      }
      if (!existing.verificationTrustState) {
        existing.verificationTrustState = VerificationTrustState.UNVERIFIED;
        changed = true;
      }
      if (existing.primaryIdentifierType !== PrimaryIdentifierType.EMAIL) {
        existing.primaryIdentifierType = PrimaryIdentifierType.EMAIL;
        changed = true;
      }
      if (changed) await users.save(existing);
      Logger.log(
        changed ? 'Existing account promoted to admin' : 'Admin already seeded',
        'AdminSeed',
      );
      return;
    }
    await users.create({
      fullName,
      email,
      password: await hashPassword(password),
      emailVerifiedAt: new Date(),
      systemRole: SystemRole.ADMIN,
      accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
    });
    Logger.log('Development admin created', 'AdminSeed');
  } finally {
    await app.close();
  }
}
void seedAdmin().catch((error) => {
  Logger.error(error.message, undefined, 'AdminSeed');
  process.exitCode = 1;
});
