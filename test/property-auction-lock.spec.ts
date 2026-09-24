import { ConflictException } from '@nestjs/common';
import { AuctionStatus } from '../src/auctions/auction.types';
import { PropertyErrorCode } from '../src/common/errors/property-error-codes';
import { PropertyAuctionLockService } from '../src/properties/property-auction-lock.service';
import { PropertiesService } from '../src/properties/properties.service';
import { PropertyLifecycleStatus } from '../src/properties/property.types';

const PROPERTY_ID = '64b000000000000000000501';
const OWNER_ID = '64b000000000000000000502';

/**
 * A tiny in-memory stand-in for the `Auction` model, matching exactly the
 * filter shape `PropertyAuctionLockService.isLocked` sends
 * (`{ propertyId, status: { $in: [...] } }`), so these tests exercise the
 * service's real query logic instead of re-asserting a mock's return value.
 */
function fakeAuctionModel(auctions: Array<{ propertyId: string; status: AuctionStatus }>) {
  const exists = jest.fn((filter: any) => ({
    exec: async () => {
      const propertyId = filter.propertyId?.toString?.() ?? filter.propertyId;
      const statuses: AuctionStatus[] = filter.status?.$in ?? [];
      const match = auctions.some((a) => a.propertyId === propertyId && statuses.includes(a.status));
      return match ? { _id: 'matched' } : null;
    },
  }));
  return { exists };
}

describe('PropertyAuctionLockService (MAZAD-024)', () => {
  it('reports not locked when the property has no auction at all', async () => {
    const service = new PropertyAuctionLockService(fakeAuctionModel([]) as any);
    await expect(service.isLocked(PROPERTY_ID)).resolves.toBe(false);
  });

  it.each([AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE])('reports locked while the auction is %s', async (status) => {
    const model = fakeAuctionModel([{ propertyId: PROPERTY_ID, status }]);
    const service = new PropertyAuctionLockService(model as any);
    await expect(service.isLocked(PROPERTY_ID)).resolves.toBe(true);
    expect(model.exists).toHaveBeenCalledWith(expect.objectContaining({
      status: { $in: [AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE] },
    }));
  });

  it.each([AuctionStatus.CANCELLED, AuctionStatus.ENDED_NO_BIDS, AuctionStatus.COMPLETED])(
    'reports not locked once the auction is terminal (%s) — the lock releases naturally',
    async (status) => {
      const service = new PropertyAuctionLockService(fakeAuctionModel([{ propertyId: PROPERTY_ID, status }]) as any);
      await expect(service.isLocked(PROPERTY_ID)).resolves.toBe(false);
    },
  );

  it('never queries for a malformed property id and reports not locked', async () => {
    const model = fakeAuctionModel([]);
    const service = new PropertyAuctionLockService(model as any);
    await expect(service.isLocked('not-an-object-id')).resolves.toBe(false);
    expect(model.exists).not.toHaveBeenCalled();
  });

  it('only ever locks the exact property queried, not other properties', async () => {
    const otherPropertyId = '64b000000000000000000999';
    const service = new PropertyAuctionLockService(fakeAuctionModel([{ propertyId: otherPropertyId, status: AuctionStatus.ACTIVE }]) as any);
    await expect(service.isLocked(PROPERTY_ID)).resolves.toBe(false);
  });

  it('assertUnlocked resolves silently when not locked', async () => {
    const service = new PropertyAuctionLockService(fakeAuctionModel([]) as any);
    await expect(service.assertUnlocked(PROPERTY_ID)).resolves.toBeUndefined();
  });

  it('assertUnlocked throws a stable conflict with PROPERTY_AUCTION_LOCKED when locked', async () => {
    const service = new PropertyAuctionLockService(fakeAuctionModel([{ propertyId: PROPERTY_ID, status: AuctionStatus.SCHEDULED }]) as any);
    await expect(service.assertUnlocked(PROPERTY_ID)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.assertUnlocked(PROPERTY_ID)).rejects.toMatchObject({
      response: expect.objectContaining({ code: PropertyErrorCode.AUCTION_LOCKED }),
    });
  });
});

/**
 * Regression coverage (MAZAD-024): proves the *existing* property lifecycle
 * endpoints — unchanged since MAZAD-019 — are actually blocked by a real
 * `PropertyAuctionLockService` (backed by a fake Auction collection) rather
 * than the MAZAD-023 no-op that always allowed everything through, and that
 * they are allowed again once the auction is no longer in a locking status.
 */
describe('PropertiesService lifecycle operations respect the real auction lock (MAZAD-024)', () => {
  function propertiesService(auctionState: Array<{ propertyId: string; status: AuctionStatus }>, propertyDoc: any) {
    const auctionLock = new PropertyAuctionLockService(fakeAuctionModel(auctionState) as any);
    const session = { withTransaction: jest.fn(async (work: () => Promise<void>) => work()), endSession: jest.fn().mockResolvedValue(undefined) };
    const properties = {
      findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue(propertyDoc) }) }),
    };
    const audit = { logRequired: jest.fn().mockResolvedValue(undefined) };
    const instance = Object.create(PropertiesService.prototype) as any;
    Object.assign(instance, { auctionLock, properties, audit, connection: { startSession: jest.fn().mockResolvedValue(session) } });
    return { instance: instance as PropertiesService, properties, auctionLock };
  }

  describe('updateOwnerVisibility', () => {
    it('is blocked while the property has a SCHEDULED auction', async () => {
      const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status: AuctionStatus.SCHEDULED }], { _id: PROPERTY_ID });
      await expect(instance.updateOwnerVisibility(OWNER_ID, PROPERTY_ID, false))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.AUCTION_LOCKED }) });
      expect(properties.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('is blocked while the property has an ACTIVE auction', async () => {
      const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status: AuctionStatus.ACTIVE }], { _id: PROPERTY_ID });
      await expect(instance.updateOwnerVisibility(OWNER_ID, PROPERTY_ID, false))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.AUCTION_LOCKED }) });
      expect(properties.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('is allowed once the auction is CANCELLED', async () => {
      const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status: AuctionStatus.CANCELLED }], { _id: PROPERTY_ID, propertyContractVersion: 1, totalPriceMinor: 100_000, currency: 'EGP', toObject: () => ({ _id: PROPERTY_ID }) });
      await expect(instance.updateOwnerVisibility(OWNER_ID, PROPERTY_ID, false)).resolves.toBeDefined();
      expect(properties.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it('is allowed when the property has never had an auction', async () => {
      const { instance, properties } = propertiesService([], { _id: PROPERTY_ID, propertyContractVersion: 1, totalPriceMinor: 100_000, currency: 'EGP', toObject: () => ({ _id: PROPERTY_ID }) });
      await expect(instance.updateOwnerVisibility(OWNER_ID, PROPERTY_ID, true)).resolves.toBeDefined();
      expect(properties.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateLifecycle (archive/restore)', () => {
    it('is blocked while ACTIVE and never starts the transaction', async () => {
      const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status: AuctionStatus.ACTIVE }], { _id: PROPERTY_ID });
      await expect(instance.updateLifecycle(OWNER_ID, PROPERTY_ID, PropertyLifecycleStatus.ARCHIVED, 0))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.AUCTION_LOCKED }) });
      expect(properties.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('is allowed once the auction has ended with no bids', async () => {
      const { instance, properties } = propertiesService(
        [{ propertyId: PROPERTY_ID, status: AuctionStatus.ENDED_NO_BIDS }],
        { _id: PROPERTY_ID, propertyContractVersion: 1, totalPriceMinor: 100_000, currency: 'EGP', toObject: () => ({ _id: PROPERTY_ID }) },
      );
      await expect(instance.updateLifecycle(OWNER_ID, PROPERTY_ID, PropertyLifecycleStatus.ARCHIVED, 0)).resolves.toBeDefined();
      expect(properties.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });
  });

  describe('forceLifecycleForAdmin (Admin hide/restore) — MAZAD-025 closure', () => {
    const ADMIN_ID = '64b000000000000000000503';
    const fixture = { _id: PROPERTY_ID, propertyContractVersion: 1, totalPriceMinor: 100_000, currency: 'EGP', toObject: () => ({ _id: PROPERTY_ID }) };

    it.each([AuctionStatus.SCHEDULED, AuctionStatus.ACTIVE])(
      'cannot hide a property while its auction is %s, so the auction can never silently drop out of public discovery',
      async (status) => {
        const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status }], fixture);
        await expect(instance.forceLifecycleForAdmin(PROPERTY_ID, PropertyLifecycleStatus.ADMIN_HIDDEN, 0, 'مخالفة', ADMIN_ID))
          .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.AUCTION_LOCKED }) });
        expect(properties.findOneAndUpdate).not.toHaveBeenCalled();
      },
    );

    it('can hide once the auction is CANCELLED or ended with no bids (lock released)', async () => {
      for (const status of [AuctionStatus.CANCELLED, AuctionStatus.ENDED_NO_BIDS]) {
        const { instance, properties } = propertiesService([{ propertyId: PROPERTY_ID, status }], fixture);
        await expect(instance.forceLifecycleForAdmin(PROPERTY_ID, PropertyLifecycleStatus.ADMIN_HIDDEN, 0, 'مخالفة', ADMIN_ID)).resolves.toBeDefined();
        expect(properties.findOneAndUpdate).toHaveBeenCalledTimes(1);
      }
    });

    it('still requires a reason to hide (rule order unchanged)', async () => {
      const { instance } = propertiesService([], fixture);
      await expect(instance.forceLifecycleForAdmin(PROPERTY_ID, PropertyLifecycleStatus.ADMIN_HIDDEN, 0, '  ', ADMIN_ID))
        .rejects.toMatchObject({ response: expect.objectContaining({ code: PropertyErrorCode.REVIEW_REASON_REQUIRED }) });
    });
  });
});
