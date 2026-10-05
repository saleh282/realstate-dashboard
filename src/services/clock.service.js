'use strict';

/** Server-authoritative clock for payment reconciliation and outbox delivery. Tests can pin the current instant. */
class ClockService {
  now() {
    return new Date();
  }
}

Object.assign(exports, { ClockService });
