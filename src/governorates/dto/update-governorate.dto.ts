import { Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { GOVERNORATE_ICON_KEYS } from '../governorate.constants';
import { MapViewportDto } from './map-viewport.dto';
export class UpdateGovernorateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameAr?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100) nameEn?: string;
  @IsOptional() @IsString() @IsIn(GOVERNORATE_ICON_KEYS) iconKey?: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsInt() @Min(0) sortOrder?: number;
  @IsOptional() @ValidateNested() @Type(() => MapViewportDto) mapViewport?: MapViewportDto;
}
