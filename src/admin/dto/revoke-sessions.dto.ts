import { IsOptional, IsString, MaxLength } from 'class-validator';

export class RevokeSessionsDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
