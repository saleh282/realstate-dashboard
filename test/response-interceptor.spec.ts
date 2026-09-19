import { ExecutionContext, StreamableFile } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';

describe('ResponseInterceptor binary responses', () => {
  it('passes StreamableFile through without wrapping or corrupting its body', async () => {
    const file = new StreamableFile(Buffer.from('%PDF-1.7\n%%EOF'));
    const result = await lastValueFrom(
      new ResponseInterceptor().intercept({} as ExecutionContext, {
        handle: () => of(file),
      }),
    );
    expect(result).toBe(file);
  });

  it('continues wrapping ordinary API results', async () => {
    const result = await lastValueFrom(
      new ResponseInterceptor().intercept({} as ExecutionContext, {
        handle: () => of({ message: 'ok', item: 1 }),
      }),
    );
    expect(result).toEqual({ success: true, message: 'ok', data: { item: 1 } });
  });
});
