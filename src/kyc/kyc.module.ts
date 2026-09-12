import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { CloudinaryModule } from '../config/cloudinary.module';
import { RolesGuard } from '../auth/roles.guard';

@Module({
  imports: [UsersModule, PassportModule, CloudinaryModule],
  controllers: [KycController],
  providers: [KycService, RolesGuard],
})
export class KycModule {}
