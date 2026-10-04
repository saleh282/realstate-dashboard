import { IsInt, IsNotEmpty, IsString, Min } from 'class-validator';

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

  // Versions of the terms and privacy policy the user ticked the box for.
  // They must be the live versions; see LegalDocumentsService.resolveAcceptance.
  @IsInt({ message: 'يجب الموافقة على الشروط والأحكام' })
  @Min(1, { message: 'يجب الموافقة على الشروط والأحكام' })
  acceptedTermsVersion: number;

  @IsInt({ message: 'يجب الموافقة على سياسة الخصوصية' })
  @Min(1, { message: 'يجب الموافقة على سياسة الخصوصية' })
  acceptedPrivacyVersion: number;
}
