import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsApplicationIdentifier } from '../../common/validators/identifier.validator';

export class LoginDto {
  @IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })
  @IsApplicationIdentifier()
  identifier: string;

  @IsNotEmpty({ message: 'كلمة المرور مطلوبة' })
  @IsString()
  password: string;

  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean; 
}
