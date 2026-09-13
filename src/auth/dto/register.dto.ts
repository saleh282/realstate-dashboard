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

  @IsNotEmpty({ message: 'البريد الإلكتروني أو رقم الهاتف مطلوب' })
  @IsApplicationIdentifier()
  identifier: string; // email OR phone - screen has a single combined field

  @IsNotEmpty({ message: 'كلمة المرور مطلوبة' })
  @IsApplicationPassword()
  password: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('password', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
