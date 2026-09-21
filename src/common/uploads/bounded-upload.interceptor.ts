import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Type, mixin } from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import type { StorageEngine } from 'multer';
import { Observable } from 'rxjs';
import { UploadTicket, getUploadBudget } from './upload-budget';

type FileFieldsArgs = Parameters<typeof FileFieldsInterceptor>;
type MulterOptions = NonNullable<FileFieldsArgs[1]>;

const ticketsByRequest = new WeakMap<object, UploadTicket>();

/**
 * multer's built-in memory storage buffers whatever the limits allow, with no
 * notion of a total. This engine buffers the same way but reports every chunk
 * to the request's UploadTicket, which enforces a per-request ceiling and the
 * process-wide budget while the body is still streaming in.
 */
export class BudgetedMemoryStorage implements StorageEngine {
  _handleFile(
    request: any,
    file: Express.Multer.File,
    callback: (error?: any, info?: Partial<Express.Multer.File>) => void,
  ): void {
    const ticket = ticketsByRequest.get(request);
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const fail = (error: unknown) => {
      if (finished) return;
      finished = true;
      ticket?.unreserve(size);
      chunks.length = 0;
      size = 0;
      callback(error);
    };
    file.stream.on('data', (chunk: Buffer) => {
      if (finished) return;
      try {
        ticket?.reserve(chunk.length);
      } catch (error) {
        fail(error);
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    file.stream.once('error', fail);
    file.stream.once('end', () => {
      if (finished) return;
      finished = true;
      callback(null, { buffer: Buffer.concat(chunks), size });
    });
  }

  _removeFile(
    request: any,
    file: Express.Multer.File,
    callback: (error: Error | null) => void,
  ): void {
    ticketsByRequest.get(request)?.unreserve(file.size ?? 0);
    delete (file as { buffer?: Buffer }).buffer;
    callback(null);
  }
}

export type BoundedUploadOptions = {
  /** Ceiling for the combined size of every file in one request. */
  maxRequestBytes: number;
  multer: MulterOptions;
};

// Text parts (DTO fields) are small; explicit ceilings stop oversized or
// numerous non-file parts from being buffered by the parser.
const DEFAULT_PARSER_LIMITS = { fieldSize: 256 * 1024, fields: 100, parts: 150 };

function bound(
  inner: NestInterceptor,
  options: BoundedUploadOptions,
): Type<NestInterceptor> {
  @Injectable()
  class BoundedUploadInterceptor implements NestInterceptor {
    async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
      const http = context.switchToHttp();
      const request = http.getRequest();
      const response = http.getResponse();
      const declared = Number.parseInt(String(request.headers?.['content-length'] ?? ''), 10);
      const ticket = getUploadBudget().admit({
        userKey: request.user?.userId ? `user:${request.user.userId}` : `ip:${request.ip}`,
        maxRequestBytes: options.maxRequestBytes,
        declaredContentLength: Number.isFinite(declared) ? declared : undefined,
      });
      ticketsByRequest.set(request, ticket);
      // 'close' fires whether the response completed or the client went away.
      response.once('close', () => ticket.release());
      try {
        return await inner.intercept(context, next);
      } catch (error) {
        ticket.release();
        throw error;
      }
    }
  }
  return mixin(BoundedUploadInterceptor);
}

function withBoundedStorage(options: BoundedUploadOptions): MulterOptions {
  return {
    ...options.multer,
    storage: new BudgetedMemoryStorage(),
    limits: { ...DEFAULT_PARSER_LIMITS, ...options.multer.limits },
  };
}

export function BoundedFileFields(
  fields: FileFieldsArgs[0],
  options: BoundedUploadOptions,
): Type<NestInterceptor> {
  const Inner = FileFieldsInterceptor(fields, withBoundedStorage(options));
  return bound(new Inner(), options);
}

export function BoundedFile(
  fieldName: string,
  options: BoundedUploadOptions,
): Type<NestInterceptor> {
  const Inner = FileInterceptor(fieldName, withBoundedStorage(options));
  return bound(new Inner(), options);
}
