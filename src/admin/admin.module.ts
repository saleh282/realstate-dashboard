import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminKycController } from './admin-kyc.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminDashboardController } from './admin-dashboard.controller';

@Module({
  imports: [UsersModule, AuditModule, PassportModule],
  controllers: [
    AdminUsersController,
    AdminKycController,
    AdminAuditController,
    AdminDashboardController,
  ],
  providers: [RolesGuard],
})
export class AdminModule {}
