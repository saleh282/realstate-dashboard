import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { EvidenceErrorCode } from '../errors/evidence-error-codes';
import { redactSensitive } from '../logging/redact';
import { classifyRejection, operationalMetrics } from '../observability/operational-metrics';
import { getRequestId, resolveRequestId } from '../request-context/request-context';

type LogKind = 'unexpected' | 'server' | 'client-upload' | 'client-disconnected';

type ErrorLogger = Pick<Logger, 'error' | 'warn'>;

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: ErrorLogger = new Logger('ExceptionFilter')) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = typeof (ctx as any).getRequest === 'function'
      ? ctx.getRequest<Request>()
      : undefined;
    const requestId = getRequestId(request) ?? resolveRequestId(request?.headers?.['x-request-id']);
    response.setHeader?.('X-Request-Id', requestId);

    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string = 'حدث خطأ غير متوقع، حاول مرة أخرى';
    let errors: string[] | undefined;
    let responseMetadata: Record<string, unknown> = {};
    let logKind: LogKind | undefined = 'unexpected';

    if ((exception as { name?: string })?.name === 'MulterError') {
      statusCode = HttpStatus.BAD_REQUEST;
      logKind = 'client-upload';
      const multerCode = (exception as { code?: string }).code;
      const tooLarge = multerCode === 'LIMIT_FILE_SIZE';
      message = tooLarge ? 'حجم ملف الإثبات يتجاوز الحد المسموح' : 'عدد ملفات الإثبات يتجاوز الحد المسموح';
      responseMetadata = {
        code: tooLarge ? EvidenceErrorCode.FILE_TOO_LARGE : EvidenceErrorCode.FILE_COUNT_EXCEEDED,
      };
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const res = exception.getResponse();
      // `quiet` marks an expected 5xx (such as a failing readiness probe) that
      // must not be reported as a server fault on every request.
      const quiet = typeof res === 'object' && res !== null && (res as { quiet?: unknown }).quiet === true;
      logKind = statusCode >= 500 && !quiet ? 'server' : undefined;

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
          'details',
          'deletion',
          'blockers',
        ];
        responseMetadata = Object.fromEntries(
          exposedKeys
            .filter((key) => Object.prototype.hasOwnProperty.call(resObj, key))
            .map((key) => [key, resObj[key]]),
        );
      }
    }

    // An error raised because the caller hung up mid-request (a dropped mobile
    // upload) is expected traffic, not a server fault.
    const callerGone = (request as { aborted?: boolean } | undefined)?.aborted === true
      || request?.socket?.destroyed === true;
    if (callerGone && logKind && logKind !== 'client-upload') logKind = 'client-disconnected';

    if (logKind) this.log(logKind, exception, statusCode, requestId, request);
    this.observe(statusCode, responseMetadata.code, requestId, request);

    if (response.headersSent) return;
    response.status(statusCode).json({
      success: false,
      message,
      ...(errors ? { errors } : {}),
      ...responseMetadata,
      requestId,
    });
  }

  /** Counts and logs the expected failures operators care about (stale form 409, amenity/spec rejections, payment trouble, rate limiting). */
  private observe(statusCode: number, code: unknown, requestId: string, request: Request | undefined) {
    const observation = classifyRejection(statusCode, code);
    if (!observation) return;
    operationalMetrics.increment(observation.event === 'rate_limited' ? 'rate_limited' : 'domain_rejection', observation.label);
    this.logger.warn(JSON.stringify({
      event: observation.event, code: observation.event === 'domain_rejection' ? observation.label : undefined, status: statusCode, requestId,
      method: request?.method, path: typeof request?.originalUrl === 'string' ? request.originalUrl.split('?')[0] : undefined,
    }));
  }

  private log(
    kind: LogKind,
    exception: unknown,
    statusCode: number,
    requestId: string,
    request: Request | undefined,
  ) {
    const error = exception instanceof Error ? exception : undefined;
    const context = {
      event: {
        unexpected: 'unhandled_exception',
        server: 'http_5xx',
        'client-upload': 'upload_rejected',
        'client-disconnected': 'client_disconnected',
      }[kind],
      requestId,
      method: request?.method,
      // The query string is dropped: it can carry tokens or personal data.
      path: typeof request?.originalUrl === 'string' ? request.originalUrl.split('?')[0] : undefined,
      status: statusCode,
      errorName: error?.name ?? typeof exception,
      code: (exception as { code?: unknown } | null)?.code,
      errorMessage: redactSensitive(error?.message ?? String(exception), 500),
    };
    const line = JSON.stringify(context);
    if (kind === 'client-upload' || kind === 'client-disconnected') {
      this.logger.warn(line);
      return;
    }
    this.logger.error(line, error?.stack ? redactSensitive(error.stack, 4000) : undefined);
  }
}
