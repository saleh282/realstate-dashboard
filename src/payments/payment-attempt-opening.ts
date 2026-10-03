import { ConflictException } from '@nestjs/common';
import { Model, Types } from 'mongoose';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { PaymentProviderPort } from './payment-provider.port';
import { EntryPaymentStatus, PaymentPurpose } from './payment.types';

/**
 * How long ONE request may hold the right to open an attempt with the provider.
 * A technical bound on a provider round trip, not a business rule: when it
 * lapses (the holder crashed or hung) another request may take over.
 */
export const INITIATION_CLAIM_LEASE_MS = 60_000;
/** A reference-less attempt older than this was abandoned mid-initiation (no hand-off ever reached a client): the worker fails it. */
export const UNREFERENCED_ATTEMPT_GRACE_MS = 5 * 60_000;

const WAIT_ROUNDS = 10;
const WAIT_MS = 150;

type AttemptRow = {
  _id: Types.ObjectId;
  status: EntryPaymentStatus;
  amountMinor: number;
  currency: string;
  providerReference?: string;
  clientHandoff?: string;
  initiationClaimedAt?: Date;
};

export type OpenedAttempt<T> = { payment: T; reused: boolean };

/**
 * Opens a live attempt with the provider EXACTLY ONCE (MAZAD-028 initiation race fix), shared by both purposes.
 *
 * The attempt row is the serialisation point. Whoever created the row holds
 * its `initiationClaimedAt` claim; a concurrent request that finds the same
 * reference-less row must first WIN that claim (an atomic compare-and-set)
 * before it may call the provider, so two simultaneous initiations produce one
 * provider order. A request that loses the claim waits briefly for the winner
 * to persist the reference and returns THAT, or answers a retryable conflict.
 *
 * The provider's reference is only ever returned after the server persisted it:
 * if the persisting compare-and-set does not match, the request re-reads the
 * row and returns what is stored, never the reference it obtained itself.
 */
export async function openAttemptWithProvider<T extends AttemptRow>(input: {
  payments: Model<any>;
  provider: PaymentProviderPort;
  purpose: PaymentPurpose;
  attempt: T;
  reused: boolean;
  now: () => Date;
  /** The provider refused: fail the reference-less attempt (purpose-specific: managed marketing also frees the request). */
  onProviderFailure: (paymentId: Types.ObjectId) => Promise<void>;
}): Promise<OpenedAttempt<T>> {
  const { payments, provider, attempt } = input;
  if (attempt.providerReference) return { payment: attempt, reused: true };

  // The creator already holds the claim (written with the row, in its transaction); anyone else must win it.
  if (input.reused && !(await claim(payments, attempt, input.now()))) {
    const settled = await waitForReference<T>(payments, attempt._id);
    if (settled) return { payment: settled, reused: true };
    throw inProgress();
  }

  let opened: { providerReference: string; clientHandoff?: string };
  try {
    opened = await provider.initiate({ purpose: input.purpose, paymentId: attempt._id.toString(), amountMinor: attempt.amountMinor, currency: attempt.currency });
  } catch (error) {
    await input.onProviderFailure(attempt._id);
    throw error;
  }

  const persisted = (await payments
    .findOneAndUpdate(
      { _id: attempt._id, status: EntryPaymentStatus.INITIATED, providerReference: { $exists: false } },
      {
        $set: { providerReference: opened.providerReference, ...(opened.clientHandoff ? { clientHandoff: opened.clientHandoff.slice(0, 2000) } : {}), nextVerifyAt: input.now() },
        $unset: { initiationClaimedAt: '' },
      },
      { new: true },
    )
    .lean()
    .exec()) as T | null;
  if (persisted) return { payment: persisted, reused: input.reused };

  // The compare-and-set did not match: this request's reference was NOT stored and must never be handed out.
  const current = (await payments.findById(attempt._id).lean().exec()) as T | null;
  if (current && current.status === EntryPaymentStatus.INITIATED && current.providerReference) return { payment: current, reused: true };
  throw inProgress();
}

async function claim(payments: Model<any>, attempt: AttemptRow, now: Date): Promise<boolean> {
  const held = attempt.initiationClaimedAt ? new Date(attempt.initiationClaimedAt) : undefined;
  if (held && now.getTime() - held.getTime() < INITIATION_CLAIM_LEASE_MS) return false;
  const taken = await payments
    .updateOne(
      { _id: attempt._id, status: EntryPaymentStatus.INITIATED, providerReference: { $exists: false }, initiationClaimedAt: held ?? { $exists: false } },
      { $set: { initiationClaimedAt: now } },
    )
    .exec();
  return taken.matchedCount === 1;
}

async function waitForReference<T extends AttemptRow>(payments: Model<any>, id: Types.ObjectId): Promise<T | null> {
  for (let round = 0; round < WAIT_ROUNDS; round++) {
    const current = (await payments.findById(id).lean().exec()) as T | null;
    if (!current || current.status !== EntryPaymentStatus.INITIATED) return null;
    if (current.providerReference) return current;
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
  return null;
}

const inProgress = () =>
  new ConflictException({ message: 'عملية الدفع قيد الفتح لدى مزود الدفع؛ أعد المحاولة بعد لحظات', code: PaymentErrorCode.INITIATION_IN_PROGRESS });
