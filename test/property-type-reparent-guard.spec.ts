import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import mongoose, { Query, Types } from 'mongoose';
import { AuditAction } from '../src/audit/schemas/audit-log.schema';
import { PropertySchema } from '../src/properties/schemas/property.schema';
import { PropertyRevisionSchema } from '../src/properties/schemas/property-revision.schema';
import { PropertyTypesService } from '../src/property-types/property-types.service';

const actorId = '64b000000000000000000001';
const typeId = '64b000000000000000000010';
const residentialId = '64b000000000000000000020';
const commercialId = '64b000000000000000000021';
const otherTypeId = '64b000000000000000000011';

const query = (value: unknown) => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(value) }) });

// MongoDB equality semantics: { field: id } matches a scalar equal to id or an array containing id.
// The array field is not declared on the schemas yet (DPF-005), so the fake only needs to match it.
const matches = (doc: Record<string, unknown>, filter: Record<string, unknown>) =>
  Object.entries(filter).every(([key, expected]) => {
    const value = doc[key];
    const same = (candidate: unknown) => String(candidate) === String(expected);
    return Array.isArray(value) ? value.some(same) : value !== undefined && same(value);
  });

const listingCollection = (docs: Record<string, unknown>[]) => {
  const calls: { filter: Record<string, unknown>; options: Record<string, unknown>; session: unknown }[] = [];
  return {
    calls,
    exists: jest.fn((filter: Record<string, unknown>) => {
      const call = { filter, options: {} as Record<string, unknown>, session: undefined as unknown };
      calls.push(call);
      const chain = {
        setOptions: (options: Record<string, unknown>) => { Object.assign(call.options, options); return chain; },
        session: (session: unknown) => { call.session = session; return chain; },
        exec: async () => (docs.some((doc) => matches(doc, filter)) ? { _id: new Types.ObjectId() } : null),
      };
      return chain;
    }),
  };
};

const setup = ({
  current = { _id: typeId, purposeCategoryId: new Types.ObjectId(residentialId), version: 3, usageCount: 0 } as Record<string, any> | null,
  properties = [] as Record<string, unknown>[],
  revisions = [] as Record<string, unknown>[],
  updated = { _id: new Types.ObjectId(typeId), code: 'apartment', nameAr: 'شقة', purposeCategoryId: new Types.ObjectId(commercialId), version: 4, isActive: true, usageCount: 0 } as Record<string, any> | null,
  purposeExists = true,
} = {}) => {
  const model = {
    findById: jest.fn().mockReturnValue({ select: () => query(current) }),
    findOneAndUpdate: jest.fn().mockReturnValue(query(updated)),
    exists: jest.fn().mockResolvedValue(current ? { _id: typeId } : null),
  };
  const purposes = { exists: jest.fn().mockResolvedValue(purposeExists ? { _id: 'purpose' } : null) };
  const audit = { logAdminResourceAction: jest.fn().mockResolvedValue(undefined) };
  const propertyModel = listingCollection(properties);
  const revisionModel = listingCollection(revisions);
  const session = {
    withTransaction: jest.fn(async (work: () => Promise<void>) => { await work(); }),
    endSession: jest.fn().mockResolvedValue(undefined),
  };
  const connection = { startSession: jest.fn().mockResolvedValue(session) };
  const service = new PropertyTypesService(model as any, purposes as any, audit as any, propertyModel as any, revisionModel as any, connection as any);
  return { service, model, purposes, audit, propertyModel, revisionModel, session, connection };
};

const expectReparentInUse = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => undefined, (caught) => caught);
  expect(error).toBeInstanceOf(ConflictException);
  expect(error.getStatus()).toBe(409);
  expect(error.getResponse()).toMatchObject({ code: 'PROPERTY_TYPE_REPARENT_IN_USE' });
};

describe('DPF-001 property type reparent guard', () => {
  const typeObjectId = new Types.ObjectId(typeId);
  const reparent = { expectedVersion: 3, purposeCategoryId: commercialId };

  it('blocks reparenting a type used as a Property primary type', async () => {
    const ctx = setup({ properties: [{ purposeSubcategoryId: typeObjectId }] });
    await expectReparentInUse(ctx.service.update(typeId, reparent, actorId));
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
    expect(ctx.audit.logAdminResourceAction).not.toHaveBeenCalled();
  });

  it('blocks reparenting a type used only as a Property additional type', async () => {
    const ctx = setup({ properties: [{ purposeSubcategoryId: new Types.ObjectId(otherTypeId), purposeSubcategoryIds: [new Types.ObjectId(otherTypeId), typeObjectId] }] });
    await expectReparentInUse(ctx.service.update(typeId, reparent, actorId));
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('blocks reparenting a type used only as a PropertyRevision primary type', async () => {
    const ctx = setup({ revisions: [{ purposeSubcategoryId: typeObjectId }] });
    await expectReparentInUse(ctx.service.update(typeId, reparent, actorId));
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('blocks reparenting a type used only as a PropertyRevision additional type', async () => {
    const ctx = setup({ revisions: [{ purposeSubcategoryId: new Types.ObjectId(otherTypeId), purposeSubcategoryIds: [typeObjectId, new Types.ObjectId(otherTypeId)] }] });
    await expectReparentInUse(ctx.service.update(typeId, reparent, actorId));
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('runs all four existence checks by type id inside the reparent transaction with strictQuery pinned off', async () => {
    const ctx = setup();
    await ctx.service.update(typeId, reparent, actorId);
    const filters = [
      ...ctx.propertyModel.calls.map((call) => ['properties', call] as const),
      ...ctx.revisionModel.calls.map((call) => ['revisions', call] as const),
    ];
    expect(filters.map(([collection, call]) => [collection, Object.keys(call.filter)[0]])).toEqual([
      ['properties', 'purposeSubcategoryId'],
      ['properties', 'purposeSubcategoryIds'],
      ['revisions', 'purposeSubcategoryId'],
      ['revisions', 'purposeSubcategoryIds'],
    ]);
    for (const [, call] of filters) {
      expect(String(Object.values(call.filter)[0])).toBe(typeId);
      expect(call.options).toEqual({ strictQuery: false });
      expect(call.session).toBe(ctx.session);
    }
    expect(ctx.session.withTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.session.endSession).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing update for a used type when purposeCategoryId is unchanged', async () => {
    const ctx = setup({
      properties: [{ purposeSubcategoryId: typeObjectId }],
      updated: { _id: typeObjectId, code: 'apartment', nameAr: 'شقة فاخرة', purposeCategoryId: new Types.ObjectId(residentialId), version: 4, isActive: false, usageCount: 7 },
    });
    await expect(ctx.service.update(typeId, { expectedVersion: 3, purposeCategoryId: residentialId, nameAr: ' شقة فاخرة ', sortOrder: 9, iconKey: 'building', isActive: false }, actorId))
      .resolves.toMatchObject({ message: 'تم تحديث نوع العقار بنجاح', nameAr: 'شقة فاخرة', purposeCategoryId: residentialId, version: 4 });
    expect(ctx.model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: typeId, $or: [{ version: 3 }] },
      { $set: { purposeCategoryId: residentialId, nameAr: 'شقة فاخرة', sortOrder: 9, iconKey: 'building', isActive: false, updatedBy: new Types.ObjectId(actorId) }, $inc: { version: 1 } },
      { new: true, runValidators: true, session: undefined },
    );
    expect(ctx.propertyModel.exists).not.toHaveBeenCalled();
    expect(ctx.revisionModel.exists).not.toHaveBeenCalled();
    expect(ctx.connection.startSession).not.toHaveBeenCalled();
  });

  it('does not read the stored purpose when purposeCategoryId is omitted', async () => {
    const ctx = setup({ properties: [{ purposeSubcategoryId: typeObjectId }] });
    await ctx.service.update(typeId, { expectedVersion: 3, nameAr: 'شقة' }, actorId);
    expect(ctx.model.findById).not.toHaveBeenCalled();
    expect(ctx.propertyModel.exists).not.toHaveBeenCalled();
    expect(ctx.connection.startSession).not.toHaveBeenCalled();
  });

  it('reparents a completely unused type to a valid purpose inside a transaction', async () => {
    const ctx = setup();
    await expect(ctx.service.update(typeId, reparent, actorId))
      .resolves.toMatchObject({ message: 'تم تحديث نوع العقار بنجاح', purposeCategoryId: commercialId, version: 4 });
    expect(ctx.purposes.exists).toHaveBeenCalledWith({ _id: commercialId, isActive: true });
    expect(ctx.model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: typeId, $or: [{ version: 3 }] },
      { $set: { purposeCategoryId: commercialId, updatedBy: new Types.ObjectId(actorId) }, $inc: { version: 1 } },
      { new: true, runValidators: true, session: ctx.session },
    );
  });

  it('treats clearing the purpose of a used type as a reparent', async () => {
    const ctx = setup({ revisions: [{ purposeSubcategoryId: typeObjectId }] });
    await expectReparentInUse(ctx.service.update(typeId, { expectedVersion: 3, purposeCategoryId: null as unknown as string }, actorId));
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps the existing target-purpose validation ahead of the usage guard', async () => {
    const ctx = setup({ purposeExists: false, properties: [{ purposeSubcategoryId: typeObjectId }] });
    const error = await ctx.service.update(typeId, reparent, actorId).catch((caught) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('غرض العقار غير موجود أو غير متاح');
    expect(ctx.model.findById).not.toHaveBeenCalled();
    expect(ctx.propertyModel.exists).not.toHaveBeenCalled();
    expect(ctx.model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('keeps the existing expectedVersion conflict on both the same-purpose and the reparent paths', async () => {
    for (const purposeCategoryId of [residentialId, commercialId]) {
      const ctx = setup({ updated: null });
      const error = await ctx.service.update(typeId, { expectedVersion: 1, purposeCategoryId }, actorId).catch((caught) => caught);
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ code: 'PROPERTY_TYPE_VERSION_CONFLICT' });
      expect(ctx.model.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: typeId, $or: [{ version: 1 }] });
      expect(ctx.audit.logAdminResourceAction).not.toHaveBeenCalled();
    }
  });

  it('keeps the legacy version-0 match and the NotFound response', async () => {
    const legacy = setup({ current: { _id: typeId, purposeCategoryId: new Types.ObjectId(residentialId) } });
    await legacy.service.update(typeId, { expectedVersion: 0, purposeCategoryId: commercialId }, actorId);
    expect(legacy.model.findOneAndUpdate.mock.calls[0][0]).toEqual({ _id: typeId, $or: [{ version: 0 }, { version: { $exists: false } }] });

    const missing = setup({ current: null, updated: null });
    await expect(missing.service.update(typeId, reparent, actorId)).rejects.toBeInstanceOf(NotFoundException);
    expect(missing.propertyModel.exists).not.toHaveBeenCalled();
  });

  it('keeps the existing audit entry for accepted updates on both paths', async () => {
    for (const purposeCategoryId of [residentialId, commercialId]) {
      const ctx = setup();
      await ctx.service.update(typeId, { expectedVersion: 3, purposeCategoryId }, actorId, '10.0.0.1');
      expect(ctx.audit.logAdminResourceAction).toHaveBeenCalledTimes(1);
      expect(ctx.audit.logAdminResourceAction).toHaveBeenCalledWith(
        AuditAction.ADMIN_PROPERTY_TYPE_UPDATED, actorId, typeId, 'updated property type apartment', '10.0.0.1',
      );
    }
  });

  it('decides by existence, never by usageCount', async () => {
    const countedButUnused = setup({ current: { _id: typeId, purposeCategoryId: new Types.ObjectId(residentialId), version: 3, usageCount: 42 } });
    await expect(countedButUnused.service.update(typeId, reparent, actorId)).resolves.toMatchObject({ purposeCategoryId: commercialId });

    const usedButUncounted = setup({
      current: { _id: typeId, purposeCategoryId: new Types.ObjectId(residentialId), version: 3, usageCount: 0 },
      properties: [{ purposeSubcategoryId: typeObjectId }],
    });
    await expectReparentInUse(usedButUncounted.service.update(typeId, reparent, actorId));
  });

  it('keeps the purposeSubcategoryIds filter through real Mongoose casting even under strictQuery', async () => {
    const connection = mongoose.createConnection();
    connection.set('strictQuery', true);
    const properties = connection.model('Dpf001Property', PropertySchema);
    const revisions = connection.model('Dpf001PropertyRevision', PropertyRevisionSchema);
    // DPF-005 declared the array on both schemas; the filter must still reach MongoDB either way.
    expect(PropertySchema.path('purposeSubcategoryIds')).toBeDefined();
    expect(PropertyRevisionSchema.path('purposeSubcategoryIds')).toBeDefined();

    const casted: [string, Record<string, unknown>][] = [];
    const exec = jest.spyOn(Query.prototype, 'exec').mockImplementation(async function (this: any) {
      casted.push([this.model.modelName, this.cast()]);
      return null;
    });
    try {
      const ctx = setup();
      const service = new PropertyTypesService(ctx.model as any, ctx.purposes as any, ctx.audit as any, properties as any, revisions as any, ctx.connection as any);
      await service.update(typeId, reparent, actorId);
    } finally {
      exec.mockRestore();
      await connection.close();
    }
    expect(casted.map(([modelName, filter]) => [modelName, Object.keys(filter), String(Object.values(filter)[0])])).toEqual([
      ['Dpf001Property', ['purposeSubcategoryId'], typeId],
      ['Dpf001Property', ['purposeSubcategoryIds'], typeId],
      ['Dpf001PropertyRevision', ['purposeSubcategoryId'], typeId],
      ['Dpf001PropertyRevision', ['purposeSubcategoryIds'], typeId],
    ]);
  });
});
