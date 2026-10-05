'use strict';

function logRecord(level, context, message, stack) {
  let fields;
  if (typeof message === 'string') {
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fields = parsed;
    } catch {
      /* Ordinary text messages need no parsing. */
    }
  }
  return JSON.stringify({
    level,
    context,
    ...(fields || { message }),
    ...(stack ? { stack } : {}),
  });
}

class Logger {
  constructor(context = 'Application') {
    this.context = context;
  }
  log(message) {
    Logger.log(message, this.context);
  }
  warn(message) {
    Logger.warn(message, this.context);
  }
  error(message, stack) {
    Logger.error(message, stack, this.context);
  }
  debug(message) {
    if (process.env.LOG_LEVEL === 'debug') this.log(message);
  }
  static log(message, context) {
    console.log(logRecord('info', context, message));
  }
  static warn(message, context) {
    console.warn(logRecord('warn', context, message));
  }
  static error(message, stack, context) {
    console.error(logRecord('error', context, message, stack));
  }
}
module.exports = { Logger };
