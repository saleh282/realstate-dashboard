import { IsEmail, IsInt, IsNotEmpty, IsString, Length, Min } from 'class-validator';

export class RequestAccountRecoveryDto {
  @IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })
  identifier: string;

  @IsNotEmpty()
  @IsString()
  password: string;
}

export class ConfirmAccountRecoveryDto {
  @IsEmail({}, { message: 'البريد الإلكتروني غير صالح' })
  identifier: string;

  @IsNotEmpty()
  @Length(6, 6)
  otp: string;

  @IsInt()
  @Min(1)
  workflowVersion: number;
}
