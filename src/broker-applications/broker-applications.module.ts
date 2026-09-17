import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { UsersModule } from '../users/users.module';
import { AdminBrokerApplicationsController } from './admin-broker-applications.controller';
import { BrokerApplicationsController } from './broker-applications.controller';
import { BrokerApplicationsService } from './broker-applications.service';
import { BrokerApplication, BrokerApplicationSchema } from './schemas/broker-application.schema';
import {
  BrokerVerificationDocument,
  BrokerVerificationDocumentSchema,
} from './schemas/broker-verification-document.schema';
import {
  BrokerVerificationRequirement,
  BrokerVerificationRequirementSchema,
} from './schemas/broker-verification-requirement.schema';

@Module({
  imports: [
    PassportModule,
    UsersModule,
    AuditModule,
    MongooseModule.forFeature([
      { name: BrokerApplication.name, schema: BrokerApplicationSchema },
      { name: BrokerVerificationDocument.name, schema: BrokerVerificationDocumentSchema },
      { name: BrokerVerificationRequirement.name, schema: BrokerVerificationRequirementSchema },
    ]),
  ],
  controllers: [BrokerApplicationsController, AdminBrokerApplicationsController],
  providers: [BrokerApplicationsService, RolesGuard],
  exports: [BrokerApplicationsService],
})
export class BrokerApplicationsModule {}
