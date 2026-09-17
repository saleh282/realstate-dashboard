import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { AccountStatus } from '../../users/identity.types';

export class UpdateUserStatusDto {
  @IsIn([
    AccountStatus.ACTIVE,
    AccountStatus.SUSPENDED,
    AccountStatus.BLOCKED,
    AccountStatus.PERMANENTLY_BANNED,
  ])
  accountStatus: AccountStatus;

  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'سبب تغيير الحالة يجب ألا يقل عن 5 أحرف' })
  @MaxLength(500)
  reason: string;
}
