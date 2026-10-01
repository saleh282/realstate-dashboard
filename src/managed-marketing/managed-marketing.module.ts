import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManagedMarketingPackage, ManagedMarketingPackageSchema } from './schemas/managed-marketing-package.schema';
import { ManagedMarketingRequest, ManagedMarketingRequestSchema } from './schemas/managed-marketing-request.schema';
import { Property, PropertySchema } from '../properties/schemas/property.schema';
import { PropertyRevision, PropertyRevisionSchema } from '../properties/schemas/property-revision.schema';
import { AuditModule } from '../audit/audit.module';
import { ManagedMarketingService } from './managed-marketing.service';
import { ManagedMarketingController } from './managed-marketing.controller';
import { AdminManagedMarketingController } from './admin-managed-marketing.controller';
import { RolesGuard } from '../auth/roles.guard';
import { PaymentsModule } from '../payments/payments.module';
import { ClockService } from '../common/time/clock.service';

@Module({
  imports: [AuditModule, PaymentsModule, MongooseModule.forFeature([
    { name: ManagedMarketingPackage.name, schema: ManagedMarketingPackageSchema },
    { name: ManagedMarketingRequest.name, schema: ManagedMarketingRequestSchema },
    { name: Property.name, schema: PropertySchema },
    { name: PropertyRevision.name, schema: PropertyRevisionSchema },
  ])],
  controllers: [ManagedMarketingController, AdminManagedMarketingController],
  providers: [ManagedMarketingService, RolesGuard, ClockService],
  exports: [MongooseModule],
})
export class ManagedMarketingModule {}
