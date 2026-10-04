import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsContactPhone } from '../../common/validators/identifier.validator';

// Either field may be sent on its own; the service rejects an empty update.
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  @MinLength(3, { message: 'الاسم الكامل يجب ألا يقل عن 3 أحرف' })
  @MaxLength(100, { message: 'الاسم الكامل يجب ألا يزيد عن 100 حرف' })
  fullName?: string;

  // Contact number only: stored unverified, never used to sign in.
  @IsOptional()
  @IsNotEmpty({ message: 'رقم الهاتف مطلوب' })
  @IsContactPhone()
  phone?: string;
}
