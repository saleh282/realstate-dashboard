import { Logger, RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { API_GLOBAL_PREFIX } from './common/http/api-prefix';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';
import { requestIdMiddleware } from './common/request-context/request-context';
import { buildCorsOptions } from './config/cors.config';
import { parseTrustProxy } from './config/trust-proxy.config';

// Orchestrator probes live outside the versioned API prefix.
export const UNPREFIXED_ROUTES = [
  { path: 'health/live', method: RequestMethod.GET },
  { path: 'health/ready', method: RequestMethod.GET },
];

// Keep-alive must outlive typical load-balancer idle timeouts (60s) or the
// balancer reuses sockets the backend has already closed and returns 502s.
const KEEP_ALIVE_TIMEOUT_MS = 65_000;

export function configureApp(app: NestExpressApplication, env: NodeJS.ProcessEnv = process.env): void {
  const logger = new Logger('Bootstrap');
  const isProduction = env.NODE_ENV === 'production';

  // Client IPs (used by the throttler) come from X-Forwarded-For only when the
  // immediate peer is a configured trusted proxy. Default: trust nothing.
  const trustProxy = parseTrustProxy(env.TRUST_PROXY).setting;
  app.set('trust proxy', trustProxy);
  if (isProduction) {
    if (trustProxy === false) {
      logger.warn(
        'TRUST_PROXY=false: forwarded client addresses are ignored. Correct only when clients connect directly; behind a reverse proxy or the admin dashboard every caller would share one rate-limit identity.',
      );
    } else if (typeof trustProxy === 'number') {
      logger.warn(
        `TRUST_PROXY=${trustProxy} (hop count): safe only if the backend is unreachable except through exactly that many proxies. Prefer listing proxy CIDRs.`,
      );
    }
  }

  app.use(requestIdMiddleware);
  app.use(helmet());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new HttpExceptionFilter());
  app.enableCors(buildCorsOptions(env));
  app.setGlobalPrefix(API_GLOBAL_PREFIX, { exclude: UNPREFIXED_ROUTES });
  app.enableShutdownHooks();
}

export function configureHttpServer(server: {
  keepAliveTimeout: number;
  headersTimeout: number;
}): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1_000;
}
