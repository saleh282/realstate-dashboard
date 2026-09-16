import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';
import { SystemRole } from '../../auth/roles.enum';

export class UpdateUserRoleDto {
  @IsIn([SystemRole.USER, SystemRole.ADMIN], { message: 'الدور المحدد غير صالح' })
  systemRole: SystemRole.USER | SystemRole.ADMIN;

  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'سبب تغيير الدور يجب ألا يقل عن 5 أحرف' })
  @MaxLength(500)
  reason: string;
}
