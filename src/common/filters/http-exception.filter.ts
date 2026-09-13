import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';


@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string = 'حدث خطأ غير متوقع، حاول مرة أخرى';
    let errors: string[] | undefined;
    let responseMetadata: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
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
    });
  }
}
