'use strict';

/** Operator diagnostics: read-only, staff only. Never part of the public readiness probe. */
class AdminOperationsController {
  constructor(operations) {
    this.operations = operations;
  }
  status() {
    return this.operations.status();
  }
}

Object.assign(exports, { AdminOperationsController });
