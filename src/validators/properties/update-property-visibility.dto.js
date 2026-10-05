'use strict';

const { Type } = require('class-transformer');
const { IsBoolean, IsInt, Min } = require('class-validator');
class UpdatePropertyVisibilityDto {}
IsBoolean()(UpdatePropertyVisibilityDto.prototype, 'isVisible');
Min(0)(UpdatePropertyVisibilityDto.prototype, 'version');
IsInt()(UpdatePropertyVisibilityDto.prototype, 'version');
Type(() => Number)(UpdatePropertyVisibilityDto.prototype, 'version');

Object.assign(exports, { UpdatePropertyVisibilityDto });
