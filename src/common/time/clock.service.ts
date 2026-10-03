import { Injectable } from '@nestjs/common';

/** Server-authoritative clock for payment reconciliation and outbox delivery. Tests can pin the current instant. */
@Injectable()
export class ClockService {
  now(): Date {
    return new Date();
  }
}
