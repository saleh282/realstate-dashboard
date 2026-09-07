import {
  CallHandler,
  ExecutionContext,
  Injectable,
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
  implements NestInterceptor<T, StandardResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<StandardResponse<T>> {
    return next.handle().pipe(
      map((result) => {
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