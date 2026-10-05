'use strict';

require('reflect-metadata');
const {
  FormDefinitionErrorCode,
} = require('../src/domain/property-form-definitions/property-form-definition.constants');
const {
  FormDraftErrorCode,
} = require('../src/domain/property-form-definitions/form-definition-drafts');
const {
  bodyOf,
  formAdminWorld,
  landInput,
  preparedDefinition,
} = require('./support/form-admin-world');
const { IDS } = require('./support/property-world');
/**
 * Phase 11 (Type-Aware Amenities) through the real Admin FormDefinition
 * lifecycle: `allowedAmenityCodes` persistence, validation, content hash,
 * diff, draft-copy-on-open and publish, over the same transactional
 * `formAdminWorld` DPF-030..032 already qualifies against.
 *
 * The fixture catalog (`FIXTURE_AMENITIES` in support/form-admin-world.ts) is
 * elevator/parking/security (active) and retired_amenity (inactive).
 */
const restrictedInput = (overrides = {}) =>
  landInput({ amenitiesEnabled: true, allowedAmenityCodes: ['elevator', 'parking'], ...overrides });
describe('Phase 11: allowedAmenityCodes through the Admin draft lifecycle', () => {
  it('saves and reads back an allowed-amenities restriction on a draft', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world, restrictedInput());
    const { draft } = await world.service.getDefinition(definitionId);
    expect(draft.amenitiesEnabled).toBe(true);
    expect(draft.allowedAmenityCodes).toEqual(['elevator', 'parking']);
  });
  it('canonicalizes (sorts) the list regardless of input order', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(
      world,
      restrictedInput({ allowedAmenityCodes: ['security', 'elevator'] }),
    );
    const { draft } = await world.service.getDefinition(definitionId);
    expect(draft.allowedAmenityCodes).toEqual(['elevator', 'security']);
  });
  it('a draft with amenitiesEnabled=false and no list reads back allowedAmenityCodes: null (legacy)', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world, landInput());
    const { draft } = await world.service.getDefinition(definitionId);
    expect(draft.amenitiesEnabled).toBe(false);
    expect(draft.allowedAmenityCodes).toBeNull();
  });
  it('rejects an unknown amenity code with a structured DRAFT_INVALID error', async () => {
    const world = formAdminWorld();
    const definitionId = (
      await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor)
    ).definition.definitionId;
    const body = await bodyOf(
      world.service.updateDraft(
        definitionId,
        {
          expectedDraftRevision: 0,
          ...restrictedInput({ allowedAmenityCodes: ['ghost_amenity'] }),
        },
        world.actor,
      ),
    );
    expect(body).toMatchObject({ status: 400, code: FormDefinitionErrorCode.DRAFT_INVALID });
    expect(body.details.errors).toContainEqual({
      code: FormDraftErrorCode.AMENITY_CODE_UNKNOWN,
      property: 'allowedAmenityCodes.ghost_amenity',
    });
  });
  it('rejects an inactive amenity code newly added to the list', async () => {
    const world = formAdminWorld();
    const definitionId = (
      await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor)
    ).definition.definitionId;
    const body = await bodyOf(
      world.service.updateDraft(
        definitionId,
        {
          expectedDraftRevision: 0,
          ...restrictedInput({ allowedAmenityCodes: ['retired_amenity'] }),
        },
        world.actor,
      ),
    );
    expect(body.details.errors).toContainEqual({
      code: FormDraftErrorCode.AMENITY_CODE_INACTIVE,
      property: 'allowedAmenityCodes.retired_amenity',
    });
  });
  it('rejects a duplicate amenity code', async () => {
    const world = formAdminWorld();
    const definitionId = (
      await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor)
    ).definition.definitionId;
    const body = await bodyOf(
      world.service.updateDraft(
        definitionId,
        {
          expectedDraftRevision: 0,
          ...restrictedInput({ allowedAmenityCodes: ['elevator', 'elevator'] }),
        },
        world.actor,
      ),
    );
    expect(body.details.errors).toContainEqual({
      code: FormDraftErrorCode.AMENITY_CODE_DUPLICATE,
      property: 'allowedAmenityCodes.elevator',
    });
  });
  it('rejects amenitiesEnabled=false with a non-empty allowedAmenityCodes', async () => {
    const world = formAdminWorld();
    const definitionId = (
      await world.service.createDefinition({ purposeSubcategoryId: IDS.unreleased }, world.actor)
    ).definition.definitionId;
    const body = await bodyOf(
      world.service.updateDraft(
        definitionId,
        { expectedDraftRevision: 0, ...landInput({ allowedAmenityCodes: ['elevator'] }) },
        world.actor,
      ),
    );
    expect(body.details.errors).toContainEqual({
      code: FormDraftErrorCode.AMENITY_ALLOWED_LIST_NOT_APPLICABLE,
      property: 'allowedAmenityCodes',
    });
  });
  it('validateDraft confirms a valid restricted draft is publishable (updateDraft already refused to save an invalid one)', async () => {
    const world = formAdminWorld();
    const { definitionId } = await preparedDefinition(world, restrictedInput());
    const result = await world.service.validateDraft(definitionId);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
describe('Phase 11: allowedAmenityCodes through publish, content hash and diff', () => {
  it('publishes with allowedAmenityCodes, and the published contentHash changes when the list changes', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision, version } = await preparedDefinition(
      world,
      restrictedInput(),
    );
    const published = await world.service.publish(
      definitionId,
      { expectedVersion: version, expectedDraftRevision: draftRevision },
      world.actor,
    );
    expect(published.definition.currentVersion).toBe(1);
    const { current } = await world.service.getDefinition(definitionId);
    expect(current.allowedAmenityCodes).toEqual(['elevator', 'parking']);
    expect(current.contentHash).toBeTruthy();
    // A second, independent definition identical except for allowedAmenityCodes hashes differently.
    const otherWorld = formAdminWorld({ withoutHead: [IDS.unreleased] });
    const other = await preparedDefinition(
      otherWorld,
      restrictedInput({ allowedAmenityCodes: ['security'] }),
    );
    const otherPublished = await otherWorld.service.publish(
      other.definitionId,
      { expectedVersion: other.version, expectedDraftRevision: other.draftRevision },
      otherWorld.actor,
    );
    expect(otherPublished.published.contentHash).not.toBe(published.published.contentHash);
  });
  it('diffDraft reports an allowedAmenityCodes change against the current published version', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision, version } = await preparedDefinition(
      world,
      restrictedInput(),
    );
    await world.service.publish(
      definitionId,
      { expectedVersion: version, expectedDraftRevision: draftRevision },
      world.actor,
    );
    await world.service.createDraft(definitionId, { expectedVersion: version + 1 }, world.actor);
    await world.service.updateDraft(
      definitionId,
      { expectedDraftRevision: 0, ...restrictedInput({ allowedAmenityCodes: ['security'] }) },
      world.actor,
    );
    const diff = await world.service.diffDraft(definitionId);
    expect(diff.form).toContainEqual({
      property: 'allowedAmenityCodes',
      before: ['elevator', 'parking'],
      after: ['security'],
    });
  });
  it('opening a new draft from a published, restricted version carries the restriction forward', async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision, version } = await preparedDefinition(
      world,
      restrictedInput(),
    );
    await world.service.publish(
      definitionId,
      { expectedVersion: version, expectedDraftRevision: draftRevision },
      world.actor,
    );
    const opened = await world.service.createDraft(
      definitionId,
      { expectedVersion: version + 1 },
      world.actor,
    );
    expect(opened.draft.allowedAmenityCodes).toEqual(['elevator', 'parking']);
  });
  it("restore's integrity check still passes for a published version carrying allowedAmenityCodes", async () => {
    const world = formAdminWorld();
    const { definitionId, draftRevision, version } = await preparedDefinition(
      world,
      restrictedInput(),
    );
    await world.service.publish(
      definitionId,
      { expectedVersion: version, expectedDraftRevision: draftRevision },
      world.actor,
    );
    await world.service.archive(
      definitionId,
      { expectedVersion: version + 1, reason: 'اختبار' },
      world.actor,
    );
    const restored = await world.service.restore(
      definitionId,
      { expectedVersion: version + 2 },
      world.actor,
    );
    expect(restored.definition.status).toBe('active');
  });
});
