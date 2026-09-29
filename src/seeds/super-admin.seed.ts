import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SystemRole } from '../auth/roles.enum';
import { hashPassword } from '../common/security/password-hashing';
import {
  AccountStatus,
  AccountType,
  BrokerStatus,
  PrimaryIdentifierType,
  VerificationTrustState,
} from '../users/identity.types';
import { UsersService } from '../users/users.service';
import { guardAction } from '../config/deployment-environment';
import { getConnectionToken } from '@nestjs/mongoose';

async function seedSuperAdmin(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const users = app.get(UsersService);

  try {
    await guardAction('seed:super-admin', process.env, app.get(getConnectionToken()).db);
    if (config.get<string>('SUPER_ADMIN_BOOTSTRAP_CONFIRM') !== 'CREATE_SUPER_ADMIN') {
      throw new Error('SUPER_ADMIN_BOOTSTRAP_CONFIRM=CREATE_SUPER_ADMIN is required');
    }
    const email = config.get<string>('SUPER_ADMIN_EMAIL')?.trim().toLowerCase();
    const password = config.get<string>('SUPER_ADMIN_PASSWORD');
    const fullName = config.get<string>('SUPER_ADMIN_FULL_NAME')?.trim();
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

void seedSuperAdmin().catch((error: Error) => {
  Logger.error(error.message, undefined, 'SuperAdminSeed');
  process.exitCode = 1;
});
