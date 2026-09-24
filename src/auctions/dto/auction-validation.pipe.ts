import { BadRequestException, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync, ValidationError } from 'class-validator';
import { AuctionErrorCode } from '../../common/errors/auction-error-codes';

function flatten(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...flatten(error.children ?? []),
  ]);
}

/**
 * Validates a query/body against a DTO class and fails with a stable
 * auction error code (`AUCTION_QUERY_INVALID` / `AUCTION_REQUEST_INVALID`)
 * instead of the generic validation error the global pipe produces.
 *
 * Handlers must type the parameter as a plain object (not the DTO class):
 * the global `ValidationPipe` skips `Object` parameters, so this pipe is the
 * single validator and the coded error is what reaches the client. The same
 * whitelist/forbidNonWhitelisted strictness as the global pipe applies, so
 * unknown fields (e.g. a client-supplied `advertiserAccountId`) are rejected,
 * never silently trusted or ignored.
 */
export function auctionValidation<T extends object>(
  dto: new () => T,
  code: AuctionErrorCode.QUERY_INVALID | AuctionErrorCode.REQUEST_INVALID,
): PipeTransform<unknown, T> {
  return {
    transform(value: unknown): T {
      const instance = plainToInstance(dto, value && typeof value === 'object' ? value : {});
      const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
      if (errors.length) {
        throw new BadRequestException({
          message: flatten(errors).join('; ') || 'بيانات الطلب غير صالحة',
          code,
        });
      }
      return instance;
    },
  };
}
