import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { User, UserSchema } from './schemas/user.schema';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { RefreshTokenModule } from '../refresh-token/refresh-token.module';
import { AuditModule } from '../audit/audit.module';
import { CloudinaryModule } from '../config/cloudinary.module';
import { AccountDeletionModule } from '../account-deletion/account-deletion.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    RefreshTokenModule,
    AuditModule,
    CloudinaryModule,
    AccountDeletionModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService, MongooseModule],
})
export class UsersModule {}
