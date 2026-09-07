import { Module } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { KycService } from './kyc.service';
import { KycController } from './kyc.controller';
import { CloudinaryProvider } from '../config/cloudinary.provider';

@Module({
  imports: [UsersModule, PassportModule],
  controllers: [KycController],
  providers: [KycService, CloudinaryProvider],
})
export class KycModule {}
