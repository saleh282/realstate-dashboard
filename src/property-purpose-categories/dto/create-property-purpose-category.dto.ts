import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreatePropertyPurposeCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(100) nameAr: string;
  @IsString() @IsNotEmpty() @MaxLength(100) nameEn: string;
  @IsOptional() @IsString() @MaxLength(500) descriptionAr?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) sortOrder?: number;
}
