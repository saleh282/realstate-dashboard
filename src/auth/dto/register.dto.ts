import { IsNotEmpty, IsString } from 'class-validator';

import {
  IsApplicationPassword,
  Match,
} from '../../common/validators/password.validator';

import {
  IsApplicationIdentifier,
  IsContactPhone,
} from '../../common/validators/identifier.validator';

export class RegisterDto {
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  @IsString()
  fullName: string;

  @IsNotEmpty({ message: 'البريد الإلكتروني مطلوب' })
  @IsApplicationIdentifier()
  identifier: string;

  // Contact number only: stored unverified, never used to sign in or receive OTPs.
  @IsNotEmpty({ message: 'رقم الهاتف مطلوب' })
  @IsContactPhone()
  phone: string;

  @IsNotEmpty({ message: 'كلمة المرور مطلوبة' })
  @IsApplicationPassword()
  password: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('password', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
