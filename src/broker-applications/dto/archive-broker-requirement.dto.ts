import { IsInt, IsNotEmpty, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class ArchiveBrokerRequirementDto {
  @IsInt()
  @Min(0)
  expectedVersion: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
