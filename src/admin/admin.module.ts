import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { UsersModule } from '../users/users.module';
import { AuditModule } from '../audit/audit.module';
import { AdminUsersController } from './admin-users.controller';
import { AdminKycController } from './admin-kyc.controller';
import { AdminAuditController } from './admin-audit.controller';
import { AdminDashboardController } from './admin-dashboard.controller';
import { AdminCompaniesController } from './admin-companies.controller';
import { CompanyAccountsService } from './company-accounts.service';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminOperationsController } from './admin-operations.controller';
import { OperationalStatusService } from '../operations/operational-status.service';

@Module({
  imports: [UsersModule, AuditModule, PassportModule, AccountDeletionModule, PaymentsModule],
  controllers: [
    AdminUsersController,
    AdminKycController,
    AdminAuditController,
    AdminDashboardController,
    AdminCompaniesController,
    AdminOperationsController,
  ],
  providers: [RolesGuard, CompanyAccountsService, OperationalStatusService],
})
export class AdminModule {}
