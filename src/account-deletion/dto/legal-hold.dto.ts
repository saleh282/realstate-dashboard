import { IsInt, IsNotEmpty, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class LegalHoldDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;

  @IsInt()
  @Min(0)
  version: number;
}

export class AdminDeletionRequestDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(500)
  reason: string;

  @IsString()
  @IsNotEmpty()
  confirmIdentifier: string;
}

export class AnonymizeAccountDto {
  @IsInt()
  @Min(0)
  version: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
