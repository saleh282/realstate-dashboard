import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Connection, Model, Types } from 'mongoose';
import { AuditLogService } from '../audit/audit-log.service';
import { AuditAction } from '../audit/schemas/audit-log.schema';
import { AuthorizationPolicyService } from '../authorization/authorization-policy.service';
import { Capability } from '../authorization/capability';
import { AuctionStatus } from '../auctions/auction.types';
import { Auction, AuctionDocument } from '../auctions/schemas/auction.schema';
import { AuctionErrorCode } from '../common/errors/auction-error-codes';
import { PaymentErrorCode } from '../common/errors/payment-error-codes';
import { EGP_CURRENCY, isMoneyMinorAmount } from '../common/money/money';
import { ClockService } from '../common/time/clock.service';
import { User, UserDocument } from '../users/schemas/user.schema';

/**
 * LEGACY internal domain service (MAZAD-028). Since MAZAD-035 the fee is set
 * by Admin approval when the Auction is created (`AuctionRequestsService`), so
 * every new auction already carries it; this remains only for auctions created
 * before the review workflow. There is NO controller. No default amount exists
 * anywhere; an auction without a configured fee cannot be paid for or
 * activated (fails closed). 0 = an explicitly FREE auction.
 */
@Injectable()
export class AuctionEntryFeeService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<AuctionDocument>,
    @InjectModel(User.name) private readonly users: Model<UserDocument>,
    private readonly audit: AuditLogService,
    private readonly clock: ClockService,
    @InjectConnection() private readonly connection: Connection,
  ) {}

  /** Write-once, only while the auction is SCHEDULED and has no fee. Requires `ADMIN_AUCTION_FEE_MANAGE`. */
  async configure(adminActorId: string, auctionId: string, amountMinor: unknown, ip?: string) {
    if (!isMoneyMinorAmount(amountMinor)) {
      throw new BadRequestException({ message: 'رسوم الاشتراك يجب أن تكون رقماً صحيحاً غير سالب بوحدات العملة الصغرى ضمن النطاق الآمن', code: PaymentErrorCode.ENTRY_FEE_INVALID });
    }
    if (!Types.ObjectId.isValid(auctionId)) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
    if (!Types.ObjectId.isValid(adminActorId)) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    const actor: any = await this.users.findById(adminActorId).lean().exec();
    if (!actor) throw new NotFoundException({ message: 'الحساب غير موجود', code: AuctionErrorCode.ACTOR_INVALID });
    // Dedicated capability: active staff only; never granted to marketplace participants.
    AuthorizationPolicyService.assert(actor, Capability.ADMIN_AUCTION_FEE_MANAGE);
    const now = this.clock.now();
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.auctions
          .findOneAndUpdate(
            { _id: new Types.ObjectId(auctionId), status: AuctionStatus.SCHEDULED, entryFee: { $exists: false } },
            { $set: { entryFee: { amountMinor, currency: EGP_CURRENCY, configuredByActorId: new Types.ObjectId(adminActorId), configuredAt: now } } },
            { new: true, session },
          )
          .exec();
        if (!updated) {
          const existing = await this.auctions.findById(auctionId).session(session).lean().exec();
          if (!existing) throw new NotFoundException({ message: 'المزاد غير موجود', code: AuctionErrorCode.NOT_FOUND });
          if ((existing as any).entryFee) throw new ConflictException({ message: 'تم تحديد رسوم الاشتراك لهذا المزاد مسبقاً', code: PaymentErrorCode.ENTRY_FEE_ALREADY_CONFIGURED });
          throw new ConflictException({ message: 'لا يمكن تحديد الرسوم إلا لمزاد مجدول', code: AuctionErrorCode.STATE_CONFLICT });
        }
        await this.audit.logRequired(
          { action: AuditAction.AUCTION_ENTRY_FEE_CONFIGURED, actorUserId: adminActorId, targetResourceId: auctionId, reason: 'entry fee configured', ip, metadata: { amountMinor, currency: EGP_CURRENCY } },
          session,
        );
      });
    } finally {
      await session.endSession();
    }
    return { auctionId, amountMinor, currency: EGP_CURRENCY };
  }
}
