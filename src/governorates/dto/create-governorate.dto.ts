import { Type } from 'class-transformer';
import { IsBoolean, IsDefined, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min, ValidateNested } from 'class-validator';
import { GOVERNORATE_ICON_KEYS } from '../governorate.constants';
import { MapViewportDto } from './map-viewport.dto';
export class CreateGovernorateDto { @IsString() @IsNotEmpty() @MaxLength(100) nameAr:string; @IsString() @IsNotEmpty() @MaxLength(100) nameEn:string; @IsString() @IsIn(GOVERNORATE_ICON_KEYS) iconKey:string; @IsOptional() @IsBoolean() isActive?:boolean; @IsOptional() @IsInt() @Min(0) sortOrder?:number; @IsDefined() @ValidateNested() @Type(() => MapViewportDto) mapViewport: MapViewportDto; }
