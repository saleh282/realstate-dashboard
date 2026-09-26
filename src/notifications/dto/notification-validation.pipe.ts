import { BadRequestException, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { NotificationErrorCode } from '../../common/errors/notification-error-codes';

function messages(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [...Object.values(error.constraints ?? {}), ...messages(error.children ?? [])]);
}

export function notificationValidation<T extends object>(
  dto: new () => T,
  code: NotificationErrorCode.QUERY_INVALID | NotificationErrorCode.PREFERENCE_INVALID,
): PipeTransform<unknown, T> {
  return {
    transform(value: unknown): T {
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
