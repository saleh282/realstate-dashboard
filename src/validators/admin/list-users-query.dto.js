'use strict';

const { Type } = require('class-transformer');
const { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } = require('class-validator');
const { SystemRole } = require('../../domain/auth/roles.enum');
const { AccountType } = require('../../domain/users/identity.types');
class ListUsersQueryDto {
  constructor() {
    this.page = 1;
    this.limit = 20;
  }
}
Min(1)(ListUsersQueryDto.prototype, 'page');
IsInt()(ListUsersQueryDto.prototype, 'page');
Type(() => Number)(ListUsersQueryDto.prototype, 'page');
Max(100)(ListUsersQueryDto.prototype, 'limit');
Min(1)(ListUsersQueryDto.prototype, 'limit');
IsInt()(ListUsersQueryDto.prototype, 'limit');
Type(() => Number)(ListUsersQueryDto.prototype, 'limit');
MaxLength(100)(ListUsersQueryDto.prototype, 'search');
IsString()(ListUsersQueryDto.prototype, 'search');
IsOptional()(ListUsersQueryDto.prototype, 'search');
IsIn(Object.values(SystemRole))(ListUsersQueryDto.prototype, 'systemRole');
IsOptional()(ListUsersQueryDto.prototype, 'systemRole');
IsIn(Object.values(AccountType))(ListUsersQueryDto.prototype, 'accountType');
IsOptional()(ListUsersQueryDto.prototype, 'accountType');
IsIn(['true', 'false'])(ListUsersQueryDto.prototype, 'contactVerified');
IsOptional()(ListUsersQueryDto.prototype, 'contactVerified');

Object.assign(exports, { ListUsersQueryDto });
