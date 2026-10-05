'use strict';

const { IsOptional, IsString } = require('class-validator');
class ListKycQueryDto {}
IsOptional()(ListKycQueryDto.prototype, 'page');
IsOptional()(ListKycQueryDto.prototype, 'limit');
IsString()(ListKycQueryDto.prototype, 'status');
IsOptional()(ListKycQueryDto.prototype, 'status');
IsString()(ListKycQueryDto.prototype, 'search');
IsOptional()(ListKycQueryDto.prototype, 'search');

Object.assign(exports, { ListKycQueryDto });
