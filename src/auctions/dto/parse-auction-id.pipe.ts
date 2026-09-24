import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionErrorCode } from '../../common/errors/auction-error-codes';

/** Rejects a malformed `:auctionId` path param with the stable AUCTION_ID_INVALID (400) before any query runs. */
@Injectable()
export class ParseAuctionIdPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !Types.ObjectId.isValid(value) || value.length !== 24) {
      throw new BadRequestException({ message: 'معرّف المزاد غير صالح', code: AuctionErrorCode.ID_INVALID });
    }
    return value;
  }
}
