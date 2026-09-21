import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

export function buildCorsOptions(env: NodeJS.ProcessEnv): CorsOptions {
  const isProduction = env.NODE_ENV === 'production';
  const configuredOrigins = (env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    origin: isProduction ? configuredOrigins : configuredOrigins.length ? configuredOrigins : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Device-Name', 'Idempotency-Key'],
  };
}
