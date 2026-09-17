import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuditModule } from '../audit/audit.module';
import { RefreshTokenModule } from '../refresh-token/refresh-token.module';
import { User, UserSchema } from '../users/schemas/user.schema';
import { Property, PropertySchema } from '../properties/schemas/property.schema';
import {
  AccountDeletionRequest,
  AccountDeletionRequestSchema,
} from './schemas/account-deletion-request.schema';
import { AccountDeletionService } from './account-deletion.service';
import { ACCOUNT_DELETION_BLOCKER_PROVIDERS } from './account-deletion.types';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Property.name, schema: PropertySchema },
      { name: AccountDeletionRequest.name, schema: AccountDeletionRequestSchema },
    ]),
    RefreshTokenModule,
    AuditModule,
  ],
  providers: [
    { provide: ACCOUNT_DELETION_BLOCKER_PROVIDERS, useValue: [] },
    AccountDeletionService,
  ],
  exports: [AccountDeletionService, MongooseModule],
})
export class AccountDeletionModule {}
