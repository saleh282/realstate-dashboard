import { Logger } from '@nestjs/common';
import { redactSensitive } from './logging/redact';

type ProcessLike = Pick<NodeJS.Process, 'on' | 'exit'>;

/**
 * Makes otherwise-silent process-level failures observable. An uncaught
 * exception leaves the process in an unknown state, so it exits non-zero and
 * lets the supervisor restart it; a rejected promise is logged loudly.
 */
export function installProcessHandlers(
  proc: ProcessLike = process,
  logger: Pick<Logger, 'error'> = new Logger('Process'),
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : undefined;
    logger.error(
      JSON.stringify({ event: 'unhandled_rejection', errorMessage: redactSensitive(error?.message ?? String(reason), 500) }),
      error?.stack ? redactSensitive(error.stack, 4000) : undefined,
    );
  });
  proc.on('uncaughtException', (error: Error) => {
    logger.error(
      JSON.stringify({ event: 'uncaught_exception', errorMessage: redactSensitive(error?.message ?? String(error), 500) }),
      error?.stack ? redactSensitive(error.stack, 4000) : undefined,
    );
    proc.exit(1);
  });
}
