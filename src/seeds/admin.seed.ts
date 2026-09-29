import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SystemRole } from '../auth/roles.enum';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} from '../users/identity.types';
import { hashPassword } from '../common/security/password-hashing';
import { UsersService } from '../users/users.service';
import { guardAction } from '../config/deployment-environment';
import { getConnectionToken } from '@nestjs/mongoose';

async function seedAdmin(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const users = app.get(UsersService);

  try {
    await guardAction('seed:dev-admin', process.env, app.get(getConnectionToken()).db);
    const email = config.get<string>('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = config.get<string>('ADMIN_PASSWORD');
    const fullName = config.get<string>('ADMIN_FULL_NAME')?.trim();
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
      Logger.log(changed ? 'Existing account promoted to admin' : 'Admin already seeded', 'AdminSeed');
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

void seedAdmin().catch((error: Error) => {
  Logger.error(error.message, undefined, 'AdminSeed');
  process.exitCode = 1;
});
