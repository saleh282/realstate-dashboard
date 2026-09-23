import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FavoritesService, FAVORITE_IDS_CAP } from '../src/favorites/favorites.service';
import { FavoriteErrorCode } from '../src/common/errors/favorite-error-codes';

/**
 * MAZAD-022 — persistent favorites.
 *
 * `fakeFavoritesCollection` is a tiny in-memory stand-in for the Mongoose
 * `favorites` model that enforces the same user+property uniqueness a real
 * unique index would, so "duplicate add"/"repeated remove" are exercised as
 * real state transitions rather than asserted on mocked call shapes. Safe
 * public projection and hidden/archived/unavailable visibility are already
 * covered end-to-end against `PropertiesService.isPubliclyVisible` /
 * `getPublicProjectionsByIds` in `property-search.spec.ts`; here those two
 * methods are mocked so `FavoritesService`'s own logic (idempotency,
 * isolation, pagination, omission handling) is what's under test.
 */
type FavoriteRow = { userId: string; propertyId: string; createdAt: Date };

function idOf(value: unknown): string {
  return value && typeof (value as any).toString === 'function' ? (value as any).toString() : String(value);
}

function fakeFavoritesCollection(seed: FavoriteRow[] = []) {
  const rows: FavoriteRow[] = [...seed];
  const limitCalls: number[] = [];

  return {
    rows,
    limitCalls,
    updateOne: jest.fn((filter: any, _update: any, options: any = {}) => ({
      exec: async () => {
        const userId = idOf(filter.userId);
        const propertyId = idOf(filter.propertyId);
        const existing = rows.find((row) => row.userId === userId && row.propertyId === propertyId);
        if (existing) return { matchedCount: 1, modifiedCount: 0, upsertedCount: 0 };
        if (options.upsert) {
          rows.push({ userId, propertyId, createdAt: new Date() });
          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      },
    })),
    deleteOne: jest.fn((filter: any) => ({
      exec: async () => {
        const userId = idOf(filter.userId);
        const propertyId = idOf(filter.propertyId);
        const index = rows.findIndex((row) => row.userId === userId && row.propertyId === propertyId);
        if (index >= 0) rows.splice(index, 1);
        return { deletedCount: index >= 0 ? 1 : 0 };
      },
    })),
    find: jest.fn((filter: any) => {
      const userId = idOf(filter.userId);
      let results = rows.filter((row) => row.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const chain: any = {
        select: () => chain,
        sort: () => chain,
        skip: (n: number) => { results = results.slice(n); return chain; },
        limit: (n: number) => { limitCalls.push(n); results = results.slice(0, n); return chain; },
        lean: () => chain,
        exec: async () => results.map((row) => ({ propertyId: { toString: () => row.propertyId }, createdAt: row.createdAt })),
      };
      return chain;
    }),
    countDocuments: jest.fn((filter: any) => ({
      exec: async () => rows.filter((row) => row.userId === idOf(filter.userId)).length,
    })),
  };
}

const USER_A = '64b000000000000000000201';
const USER_B = '64b000000000000000000202';
const PROPERTY_1 = '64b000000000000000000301';
const PROPERTY_2 = '64b000000000000000000302';
const PROPERTY_HIDDEN = '64b000000000000000000303';

function service(seed: FavoriteRow[] = [], propertiesOverrides: Record<string, unknown> = {}) {
  const favorites = fakeFavoritesCollection(seed);
  const properties = {
    isPubliclyVisible: jest.fn().mockResolvedValue(true),
    getPublicProjectionsByIds: jest.fn().mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, { id, title: `عقار ${id}` }]))),
    ...propertiesOverrides,
  };
  const instance = Object.create(FavoritesService.prototype) as any;
  Object.assign(instance, { favorites, properties });
  return { instance: instance as FavoritesService, favorites, properties };
}

describe('FavoritesService (MAZAD-022)', () => {
  describe('add', () => {
    it('creates a favorite for a valid, publicly visible property', async () => {
      const { instance, favorites } = service();
      await expect(instance.add(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإضافة إلى المفضلة' });
      expect(favorites.rows).toEqual([{ userId: USER_A, propertyId: PROPERTY_1, createdAt: expect.any(Date) }]);
    });

    it('rejects a malformed property id without checking visibility', async () => {
      const { instance, properties } = service();
      await expect(instance.add(USER_A, 'not-an-object-id')).rejects.toMatchObject({
        response: expect.objectContaining({ code: FavoriteErrorCode.PROPERTY_INVALID }),
      });
      expect(properties.isPubliclyVisible).not.toHaveBeenCalled();
    });

    it('rejects a property that is not publicly visible (hidden/archived/rejected/missing)', async () => {
      const { instance, favorites } = service([], { isPubliclyVisible: jest.fn().mockResolvedValue(false) });
      await expect(instance.add(USER_A, PROPERTY_HIDDEN)).rejects.toMatchObject({
        response: expect.objectContaining({ code: FavoriteErrorCode.PROPERTY_NOT_AVAILABLE }),
      });
      expect(favorites.rows).toHaveLength(0);
    });

    it('adding an already-favorited property twice does not create a duplicate (idempotent)', async () => {
      const { instance, favorites } = service();
      await instance.add(USER_A, PROPERTY_1);
      await expect(instance.add(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإضافة إلى المفضلة' });
      expect(favorites.rows).toHaveLength(1);
    });

    it('two different users can each favorite the same property independently', async () => {
      const { instance, favorites } = service();
      await instance.add(USER_A, PROPERTY_1);
      await instance.add(USER_B, PROPERTY_1);
      expect(favorites.rows).toHaveLength(2);
    });

    it('treats a concurrent duplicate-key race on the unique index as already-favorited, not an error', async () => {
      const { instance } = service();
      (instance as any).favorites = {
        updateOne: jest.fn()
          .mockImplementationOnce(() => ({ exec: async () => ({ upsertedCount: 1 }) }))
          .mockImplementationOnce(() => ({ exec: async () => { throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 }); } })),
      };
      await expect(instance.add(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإضافة إلى المفضلة' });
      await expect(instance.add(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإضافة إلى المفضلة' });
    });

    it('propagates an unrelated database error instead of swallowing it', async () => {
      const { instance } = service();
      (instance as any).favorites = {
        updateOne: jest.fn(() => ({ exec: async () => { throw new Error('connection reset'); } })),
      };
      await expect(instance.add(USER_A, PROPERTY_1)).rejects.toThrow('connection reset');
    });
  });

  describe('remove', () => {
    it('removes an existing favorite', async () => {
      const seed: FavoriteRow[] = [{ userId: USER_A, propertyId: PROPERTY_1, createdAt: new Date() }];
      const { instance, favorites } = service(seed);
      await expect(instance.remove(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإزالة من المفضلة' });
      expect(favorites.rows).toHaveLength(0);
    });

    it('removing an already-removed (or never-existing) favorite is a safe no-op', async () => {
      const { instance } = service([]);
      await expect(instance.remove(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإزالة من المفضلة' });
      await expect(instance.remove(USER_A, PROPERTY_1)).resolves.toEqual({ message: 'تمت الإزالة من المفضلة' });
    });

    it('rejects a malformed property id', async () => {
      const { instance } = service();
      await expect(instance.remove(USER_A, 'not-an-object-id')).rejects.toMatchObject({
        response: expect.objectContaining({ code: FavoriteErrorCode.PROPERTY_INVALID }),
      });
    });

    it('cross-user isolation: a user cannot remove another user\'s favorite', async () => {
      const seed: FavoriteRow[] = [{ userId: USER_A, propertyId: PROPERTY_1, createdAt: new Date() }];
      const { instance, favorites } = service(seed);
      await instance.remove(USER_B, PROPERTY_1);
      expect(favorites.rows).toEqual([{ userId: USER_A, propertyId: PROPERTY_1, createdAt: expect.any(Date) }]);
    });
  });

  describe('cross-user isolation (list/ids)', () => {
    const seed: FavoriteRow[] = [
      { userId: USER_A, propertyId: PROPERTY_1, createdAt: new Date('2026-01-01') },
      { userId: USER_B, propertyId: PROPERTY_2, createdAt: new Date('2026-01-02') },
    ];

    it('ids() only returns the requesting user\'s favorited property ids', async () => {
      const { instance } = service(seed);
      await expect(instance.ids(USER_A)).resolves.toEqual({ propertyIds: [PROPERTY_1] });
      await expect(instance.ids(USER_B)).resolves.toEqual({ propertyIds: [PROPERTY_2] });
    });

    it('ids() bounds the query with the documented cap', async () => {
      const { instance, favorites } = service(seed);
      await instance.ids(USER_A);
      expect(favorites.limitCalls).toContain(FAVORITE_IDS_CAP);
    });

    it('list() only returns the requesting user\'s favorites', async () => {
      const { instance } = service(seed);
      const result = await instance.list(USER_A);
      expect(result.items.map((item: any) => item.id)).toEqual([PROPERTY_1]);
      expect(result.pagination.total).toBe(1);
    });
  });

  describe('list pagination', () => {
    const seed: FavoriteRow[] = Array.from({ length: 25 }, (_, index) => ({
      userId: USER_A,
      propertyId: `64b0000000000000000004${String(index).padStart(2, '0')}`,
      createdAt: new Date(2026, 0, index + 1),
    }));

    it('defaults to page 1 / limit 20 and reports totalPages from the raw favorite count', async () => {
      const { instance } = service(seed);
      const result = await instance.list(USER_A);
      expect(result.items).toHaveLength(20);
      expect(result.pagination).toEqual({ page: 1, limit: 20, total: 25, totalPages: 2 });
    });

    it('returns the second page', async () => {
      const { instance } = service(seed);
      const result = await instance.list(USER_A, { page: 2, limit: 20 });
      expect(result.items).toHaveLength(5);
      expect(result.pagination.page).toBe(2);
    });

    it('clamps an out-of-range page/limit instead of erroring', async () => {
      const { instance } = service(seed);
      const result = await instance.list(USER_A, { page: 0 as any, limit: 999 as any });
      expect(result.pagination.page).toBe(1);
      expect(result.pagination.limit).toBe(50);
      expect(result.items).toHaveLength(25);
    });

    it('sorts newest-favorited first', async () => {
      const { instance } = service(seed);
      const result = await instance.list(USER_A, { limit: 1 });
      expect(result.items[0].id).toBe(seed[seed.length - 1].propertyId);
    });
  });

  describe('list omits properties that are no longer publicly visible', () => {
    it('a favorite whose property became hidden/archived/unavailable is skipped, not exposed, while pagination.total is unaffected', async () => {
      const seed: FavoriteRow[] = [
        { userId: USER_A, propertyId: PROPERTY_1, createdAt: new Date('2026-01-01') },
        { userId: USER_A, propertyId: PROPERTY_HIDDEN, createdAt: new Date('2026-01-02') },
      ];
      const { instance, properties } = service(seed, {
        getPublicProjectionsByIds: jest.fn().mockResolvedValue(new Map([[PROPERTY_1, { id: PROPERTY_1, title: 'عقار متاح' }]])),
      });
      const result = await instance.list(USER_A);
      expect(result.items.map((item: any) => item.id)).toEqual([PROPERTY_1]);
      expect(result.pagination.total).toBe(2);
      expect(properties.getPublicProjectionsByIds).toHaveBeenCalledWith([PROPERTY_HIDDEN, PROPERTY_1]);
    });

    it('uses the exact safe projection PropertiesService returns, plus favoritedAt', async () => {
      const favoritedAt = new Date('2026-01-05');
      const seed: FavoriteRow[] = [{ userId: USER_A, propertyId: PROPERTY_1, createdAt: favoritedAt }];
      const projection = { id: PROPERTY_1, title: 'شقة للبيع', governorateCode: 'cairo' };
      const { instance } = service(seed, { getPublicProjectionsByIds: jest.fn().mockResolvedValue(new Map([[PROPERTY_1, projection]])) });
      const result = await instance.list(USER_A);
      expect(result.items[0]).toEqual({ ...projection, favoritedAt });
      expect(result.items[0]).not.toHaveProperty('reviewedBy');
      expect(result.items[0]).not.toHaveProperty('privateEvidence');
    });
  });
});
