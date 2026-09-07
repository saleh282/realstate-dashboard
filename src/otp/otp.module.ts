import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OtpVerification, OtpVerificationSchema } from './schemas/otp-verification.schema';
import { OtpVerificationService } from './otp-verification.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: OtpVerification.name, schema: OtpVerificationSchema }]),
  ],
  providers: [OtpVerificationService],
  exports: [OtpVerificationService],
})
export class OtpModule {}
