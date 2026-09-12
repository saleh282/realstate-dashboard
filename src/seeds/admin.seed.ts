import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { UserRole } from '../auth/roles.enum';
import { hashPassword } from '../common/security/password-hashing';
import { UsersService } from '../users/users.service';

async function seedAdmin(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule);
  const config = app.get(ConfigService);
  const users = app.get(UsersService);

  try {
    const email = config.get<string>('ADMIN_EMAIL')?.trim().toLowerCase();
    const password = config.get<string>('ADMIN_PASSWORD');
    const fullName = config.get<string>('ADMIN_FULL_NAME')?.trim();
    if (!email || !password || !fullName) {
      throw new Error('ADMIN_EMAIL, ADMIN_PASSWORD, and ADMIN_FULL_NAME are required');
    }

    const existing = await users.findByIdentifier(email);
    if (existing) {
      let changed = false;
      if (existing.role !== UserRole.ADMIN) {
        existing.role = UserRole.ADMIN;
        changed = true;
      }
      if (!existing.emailVerified) {
        existing.emailVerified = true;
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
      emailVerified: true,
      role: UserRole.ADMIN,
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
