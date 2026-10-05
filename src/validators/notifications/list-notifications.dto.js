'use strict';

const { Transform, Type } = require('class-transformer');
const { IsBoolean, IsInt, IsOptional, Max, Min } = require('class-validator');
class ListNotificationsDto {}
Max(10_000)(ListNotificationsDto.prototype, 'page');
Min(1)(ListNotificationsDto.prototype, 'page');
IsInt()(ListNotificationsDto.prototype, 'page');
Type(() => Number)(ListNotificationsDto.prototype, 'page');
IsOptional()(ListNotificationsDto.prototype, 'page');
Max(50)(ListNotificationsDto.prototype, 'limit');
Min(1)(ListNotificationsDto.prototype, 'limit');
IsInt()(ListNotificationsDto.prototype, 'limit');
Type(() => Number)(ListNotificationsDto.prototype, 'limit');
IsOptional()(ListNotificationsDto.prototype, 'limit');
IsBoolean()(ListNotificationsDto.prototype, 'unread');
Transform(({ value }) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return value;
})(ListNotificationsDto.prototype, 'unread');
IsOptional()(ListNotificationsDto.prototype, 'unread');

Object.assign(exports, { ListNotificationsDto });
