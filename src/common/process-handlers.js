'use strict';

const { Logger } = require('./logging/logger');
const { redactSensitive } = require('./logging/redact');
/**
 * Makes otherwise-silent process-level failures observable. An uncaught
 * exception leaves the process in an unknown state, so it exits non-zero and
 * lets the supervisor restart it; a rejected promise is logged loudly.
 */
function installProcessHandlers(proc = process, logger = new Logger('Process')) {
  proc.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : undefined;
    logger.error(
      JSON.stringify({
        event: 'unhandled_rejection',
        errorMessage: redactSensitive(error?.message ?? String(reason), 500),
      }),
      error?.stack ? redactSensitive(error.stack, 4000) : undefined,
    );
  });
  proc.on('uncaughtException', (error) => {
    logger.error(
      JSON.stringify({
        event: 'uncaught_exception',
        errorMessage: redactSensitive(error?.message ?? String(error), 500),
      }),
      error?.stack ? redactSensitive(error.stack, 4000) : undefined,
    );
    proc.exit(1);
  });
}

Object.assign(exports, { installProcessHandlers });
