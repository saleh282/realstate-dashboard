import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SystemRole } from '../../auth/roles.enum';
import { AccountType } from '../../users/identity.types';

export class ListUsersQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @IsIn(Object.values(SystemRole))
  systemRole?: SystemRole;

  @IsOptional()
  @IsIn(Object.values(AccountType))
  accountType?: AccountType;

  @IsOptional()
  @IsIn(['true', 'false'])
  contactVerified?: 'true' | 'false';
}
