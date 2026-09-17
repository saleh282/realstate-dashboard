import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdateBrokerRequirementDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  labelAr?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  labelEn?: string;

  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @IsInt()
  @Min(0)
  expectedVersion: number;
}
