import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { PassportModule } from '@nestjs/passport';
import { AuditModule } from '../audit/audit.module';
import { RolesGuard } from '../auth/roles.guard';
import { AdminAmenitiesController } from './admin-amenities.controller';
import { AmenitiesController } from './amenities.controller';
import { AmenitiesService } from './amenities.service';
import { Amenity, AmenitySchema } from './schemas/amenity.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: Amenity.name, schema: AmenitySchema }]), AuditModule, PassportModule],
  controllers: [AmenitiesController, AdminAmenitiesController],
  providers: [AmenitiesService, RolesGuard],
  exports: [AmenitiesService],
})
export class AmenitiesModule {}
