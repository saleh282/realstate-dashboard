import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ManagedMarketingPackage, ManagedMarketingPackageSchema } from './schemas/managed-marketing-package.schema';
import { ManagedMarketingRequest, ManagedMarketingRequestSchema } from './schemas/managed-marketing-request.schema';

@Module({
  imports: [MongooseModule.forFeature([
    { name: ManagedMarketingPackage.name, schema: ManagedMarketingPackageSchema },
    { name: ManagedMarketingRequest.name, schema: ManagedMarketingRequestSchema },
  ])],
  exports: [MongooseModule],
})
export class ManagedMarketingModule {}
