'use strict';

const { BadRequestException } = require('../../common/http/errors');
const { plainToInstance } = require('class-transformer');
const { validateSync } = require('class-validator');
function messages(errors) {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...messages(error.children ?? []),
  ]);
}
function notificationValidation(dto, code) {
  return {
    transform(value) {
      const instance = plainToInstance(dto, value && typeof value === 'object' ? value : {});
      const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length) {
        throw new BadRequestException({
          message: messages(errors).join('; ') || 'بيانات الإشعارات غير صالحة',
          code,
        });
      }
      return instance;
    },
  };
}

Object.assign(exports, { notificationValidation });
