import { IsString, MaxLength, MinLength } from 'class-validator';

export class DeleteAdminUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  confirmIdentifier: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
