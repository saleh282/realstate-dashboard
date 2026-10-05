'use strict';
require('dotenv/config');
const { createContext } = require('../config/database');
const { Logger } = require('../common/logging/logger');
const { ConfigService } = require('../config/config');
const { SystemRole } = require('../domain/auth/roles.enum');
const { hashPassword } = require('../common/security/password-hashing');
const {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} = require('../domain/users/identity.types');
const { UsersService } = require('../services/users.service');
const { guardAction } = require('../config/deployment-environment');
async function seedSuperAdmin() {
  const app = await createContext({ initialize: false });
  const config = app.services.ConfigService;
  const users = app.services.UsersService;
  try {
    await guardAction('seed:super-admin', process.env, app.connection.db);
    if (config.get('SUPER_ADMIN_BOOTSTRAP_CONFIRM') !== 'CREATE_SUPER_ADMIN') {
      throw new Error('SUPER_ADMIN_BOOTSTRAP_CONFIRM=CREATE_SUPER_ADMIN is required');
    }
    const email = config.get('SUPER_ADMIN_EMAIL')?.trim().toLowerCase();
    const password = config.get('SUPER_ADMIN_PASSWORD');
    const fullName = config.get('SUPER_ADMIN_FULL_NAME')?.trim();
    if (!email || !password || !fullName) {
      throw new Error(
        'SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD, and SUPER_ADMIN_FULL_NAME are required',
      );
    }
    const existing = await users.findByIdentifier(email);
    if (existing) {
      existing.systemRole = SystemRole.SUPER_ADMIN;
      existing.accountType = existing.accountType ?? AccountType.USER;
      existing.accountStatus = AccountStatus.ACTIVE;
      existing.brokerStatus = existing.brokerStatus ?? BrokerStatus.NOT_APPLIED;
      existing.verificationTrustState =
        existing.verificationTrustState ?? VerificationTrustState.UNVERIFIED;
      existing.primaryIdentifierType = PrimaryIdentifierType.EMAIL;
      existing.emailVerifiedAt = existing.emailVerifiedAt ?? new Date();
      await users.save(existing);
      Logger.log('Existing account bootstrapped as SUPER_ADMIN', 'SuperAdminSeed');
      return;
    }
    await users.create({
      fullName,
      email,
      password: await hashPassword(password),
      systemRole: SystemRole.SUPER_ADMIN,
      accountType: AccountType.USER,
      accountStatus: AccountStatus.ACTIVE,
      brokerStatus: BrokerStatus.NOT_APPLIED,
      verificationTrustState: VerificationTrustState.UNVERIFIED,
      primaryIdentifierType: PrimaryIdentifierType.EMAIL,
      emailVerifiedAt: new Date(),
    });
    Logger.log('SUPER_ADMIN bootstrapped', 'SuperAdminSeed');
  } finally {
    await app.close();
  }
}
void seedSuperAdmin().catch((error) => {
  Logger.error(error.message, undefined, 'SuperAdminSeed');
  process.exitCode = 1;
});
