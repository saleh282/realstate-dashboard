import {
  CallHandler,
  ExecutionContext,
  Injectable,
  StreamableFile,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface StandardResponse<T> {
  success: boolean;
  message: string;
  data: T | null;
}

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, StandardResponse<T> | StreamableFile>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T> | StreamableFile> {
    return next.handle().pipe(
      map((result) => {
        // Binary controller responses must reach Nest's StreamableFile handler.
        // Wrapping them in the JSON envelope corrupts the advertised file body.
        if (result instanceof StreamableFile) return result;

        if (result === undefined || result === null) {
          return {
            success: true,
            message: 'تمت العملية بنجاح',
            data: null,
          };
        }

        if (typeof result === 'object' && 'message' in result) {
          const { message, ...rest } = result as Record<string, any>;
          const hasExtraData = Object.keys(rest).length > 0;

          return {
            success: true,
            message,
            data: hasExtraData ? (rest as T) : null,
          };
        }

        return {
          success: true,
          message: 'تمت العملية بنجاح',
          data: result,
        };
      }),
    );
  }
}
