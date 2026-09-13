import { IsBoolean, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class UpdateUserStatusDto {
  @IsBoolean()
  isActive: boolean;

  @IsString()
  @IsNotEmpty()
  @MinLength(5, { message: 'سبب تغيير الحالة يجب ألا يقل عن 5 أحرف' })
  @MaxLength(500)
  reason: string;
}
