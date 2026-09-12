import { IsIn, IsNotEmpty, IsString, Length } from 'class-validator';
import {
  IsApplicationPassword,
  Match,
} from '../../common/validators/password.validator';

export enum OtpPurpose {
  REGISTER = 'register',
  PASSWORD_RESET = 'password_reset',
}

export class ForgotPasswordDto {
  @IsNotEmpty({ message: 'البريد الإلكتروني أو رقم الهاتف مطلوب' })
  @IsString()
  identifier: string;
}

export class ResendOtpDto {
  @IsNotEmpty()
  @IsString()
  identifier: string;

  // نفس منطق verify-otp: لازم نعرف الغرض عشان نبعت للـ otp_verifications الصح
  @IsNotEmpty({ message: 'purpose مطلوب: register أو password_reset' })
  @IsIn(['register', 'password_reset'], { message: 'purpose لازم يكون register أو password_reset' })
  purpose: OtpPurpose;
}

export class VerifyOtpDto {
  @IsNotEmpty()
  @IsString()
  identifier: string;

  @IsNotEmpty({ message: 'رمز التحقق مطلوب' })
  @Length(6, 6, { message: 'رمز التحقق يتكون من 6 أرقام' })
  otp: string;

  // لازم تتبعت دايماً: 'register' بعد التسجيل، أو 'password_reset' بعد نسيان كلمة المرور
  @IsNotEmpty({ message: 'purpose مطلوب: register أو password_reset' })
  @IsIn([OtpPurpose.REGISTER, OtpPurpose.PASSWORD_RESET], {
    message: 'purpose لازم يكون register أو password_reset',
  })
  purpose: OtpPurpose;
}

export class ResetPasswordDto {
  @IsNotEmpty({ message: 'جلسة إعادة التعيين غير صالحة' })
  @IsString()
  resetToken: string;

  @IsNotEmpty({ message: 'كلمة المرور الجديدة مطلوبة' })
  @IsApplicationPassword()
  newPassword: string;

  @IsNotEmpty({ message: 'تأكيد كلمة المرور مطلوب' })
  @Match('newPassword', { message: 'كلمتا المرور غير متطابقتين' })
  confirmPassword: string;
}
