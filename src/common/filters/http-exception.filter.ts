import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { Request } from 'express';
import { randomUUID } from 'crypto';
import { EvidenceErrorCode } from '../errors/evidence-error-codes';


@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = typeof (ctx as any).getRequest === 'function'
      ? ctx.getRequest<Request>()
      : undefined;
    const suppliedRequestId = request?.headers?.['x-request-id'];
    const requestId = typeof suppliedRequestId === 'string' && suppliedRequestId.length <= 100
      ? suppliedRequestId
      : randomUUID();
    response.setHeader?.('X-Request-Id', requestId);

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string = 'حدث خطأ غير متوقع، حاول مرة أخرى';
    let errors: string[] | undefined;
    let responseMetadata: Record<string, unknown> = {};

    if ((exception as { name?: string })?.name === 'MulterError') {
      statusCode = HttpStatus.BAD_REQUEST;
      const multerCode = (exception as { code?: string }).code;
      const tooLarge = multerCode === 'LIMIT_FILE_SIZE';
      message = tooLarge ? 'حجم ملف الإثبات يتجاوز الحد المسموح' : 'عدد ملفات الإثبات يتجاوز الحد المسموح';
      responseMetadata = {
        code: tooLarge ? EvidenceErrorCode.FILE_TOO_LARGE : EvidenceErrorCode.FILE_COUNT_EXCEEDED,
      };
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object' && res !== null) {
        const resObj = res as Record<string, any>;

        if (Array.isArray(resObj.message)) {
          errors = resObj.message;
          message = resObj.message[0] ?? message;
        } else if (resObj.message) {
          message = resObj.message;
        }

        const exposedKeys = [
          'code',
          'isVerified',
          'requiresVerification',
          'otpSent',
          'identifier',
          'expiresInMinutes',
          'retryAfterSeconds',
        ];
        responseMetadata = Object.fromEntries(
          exposedKeys
            .filter((key) => Object.prototype.hasOwnProperty.call(resObj, key))
            .map((key) => [key, resObj[key]]),
        );
      }
    }

    response.status(statusCode).json({
      success: false,
      message,
      ...(errors ? { errors } : {}),
      ...responseMetadata,
      requestId,
    });
  }
}
