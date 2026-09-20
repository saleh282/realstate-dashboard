import { IsBoolean, IsInt, IsMongoId, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateCityDto {
  @IsOptional()
  @IsMongoId()
  governorateId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameAr?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nameEn?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;
}
