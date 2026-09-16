import { IsNotEmpty, IsString } from 'class-validator';
import {
  IsApplicationPassword,
  Match,
} from '../../common/validators/password.validator';
import { IsApplicationIdentifier } from '../../common/validators/identifier.validator';

export class RegisterDto {
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  @IsString()
  fullName: string;

  @IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })
  @IsApplicationIdentifier()
  identifier: string; // V1 auth accepts email only; phone remains contact data.

  @IsNotEmpty({ message: 'كلمة المرور مطلوبة' })
  @IsApplicationPassword()
  password: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('password', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
