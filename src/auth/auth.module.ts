import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { OtpModule } from '../otp/otp.module';
import { RefreshTokenModule } from '../refresh-token/refresh-token.module';
import { AuditModule } from '../audit/audit.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { MailService } from './mail.service';
import { JwtStrategy } from './jwt.strategy';
import { JwtRefreshStrategy } from './jwt-refresh.strategy';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';
import { LegalDocumentsModule } from '../legal-documents/legal-documents.module';

@Module({
  imports: [
    UsersModule,
    PassportModule,
    JwtModule.register({}),
    OtpModule,
    RefreshTokenModule,
    AuditModule,
    AccountDeletionModule,
    LegalDocumentsModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, MailService, JwtStrategy, JwtRefreshStrategy],
  exports: [AuthService, MailService, JwtStrategy],
})
export class AuthModule {}
