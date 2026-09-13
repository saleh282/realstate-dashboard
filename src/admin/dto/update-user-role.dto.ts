import { IsEnum, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole } from '../../auth/roles.enum';

export class UpdateUserRoleDto {
  @IsEnum(UserRole, { message: 'الدور المحدد غير صالح' })
  role: UserRole;

  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'سبب تغيير الدور يجب ألا يقل عن 5 أحرف' })
  @MaxLength(500)
  reason: string;
}
