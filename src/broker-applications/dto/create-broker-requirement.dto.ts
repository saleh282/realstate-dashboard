import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateBrokerRequirementDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z][A-Za-z0-9_-]{1,79}$/)
  code: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  labelAr: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  labelEn?: string;

  @IsBoolean()
  required: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder: number;
}
