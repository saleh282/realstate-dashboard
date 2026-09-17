import { IsEmail, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { IsApplicationPassword } from '../../common/validators/password.validator';

export class CreateCompanyAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'اسم الشركة مطلوب' })
  @MinLength(2)
  @MaxLength(200)
  fullName: string;

  @IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })
  @MaxLength(254)
  email: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsApplicationPassword()
  initialPassword: string;
}
