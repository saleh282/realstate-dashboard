import { Type } from 'class-transformer';
import { IsNumber, Max, Min, ValidateNested } from 'class-validator';

export class MapCoordinateDto {
  @IsNumber() @Min(-90) @Max(90) latitude: number;
  @IsNumber() @Min(-180) @Max(180) longitude: number;
}

export class MapBoundsDto {
  @ValidateNested() @Type(() => MapCoordinateDto) southWest: MapCoordinateDto;
  @ValidateNested() @Type(() => MapCoordinateDto) northEast: MapCoordinateDto;
}

export class MapViewportDto {
  @ValidateNested() @Type(() => MapCoordinateDto) center: MapCoordinateDto;
  @ValidateNested() @Type(() => MapBoundsDto) bounds: MapBoundsDto;
}
