import { ConflictException, Injectable } from '@nestjs/common';
import { PropertyErrorCode } from '../common/errors/property-error-codes';

/** Provider-neutral boundary. The auction module replaces this implementation later. */
@Injectable()
export class PropertyAuctionLockService {
  async isLocked(_propertyId: string): Promise<boolean> { return false; }

  async assertUnlocked(propertyId: string): Promise<void> {
    if (await this.isLocked(propertyId)) {
      throw new ConflictException({ message: 'يجب إلغاء المزاد المجدول أو النشط قبل تعديل حالة العقار', code: PropertyErrorCode.AUCTION_LOCKED });
    }
  }
}
