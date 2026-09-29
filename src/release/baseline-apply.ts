/**
 * Applies the FORM part of a baseline manifest through the real Admin service,
 * so every publication keeps its transactional token checks and audit rows.
 * Catalogs are never created here: they belong to the seeds and migrations, and
 * a missing or divergent catalog aborts the apply.
 *
 *  - missing form            -> create the definition, fill its draft, publish
 *  - matching form           -> untouched
 *  - divergent form          -> refused, unless its type code is in `allowPublish`,
 *                              in which case a NEW version is published (published
 *                              versions are immutable; old revisions keep theirs)
 * Dry-run performs no write and lists what would happen.
 */
import type { Db } from 'mongodb';
import type { AdminPropertyFormDefinitionsService } from '../property-form-definitions/admin-property-form-definitions.service';
import type { FormFieldDto } from '../property-form-definitions/dto/admin-form-definition.dto';
import { computeFormContentHash } from '../property-form-definitions/property-form-definition.constants';
import { BaselineManifest, ManifestForm, VerifyReport, manifestIntegrityProblems, verifyAgainstManifest } from './baseline-manifest';

export type ApplyAction = 'create' | 'publish-new-version' | 'refuse-divergence' | 'unchanged';
export type ApplyPlanItem = { propertyTypeCode: string; action: ApplyAction; detail?: string };
export type ApplyResult = { dryRun: boolean; ok: boolean; blockers: string[]; plan: ApplyPlanItem[]; published: string[]; report: VerifyReport };

export class ManifestApplyError extends Error {}

export function planApply(report: VerifyReport, allowPublish: ReadonlySet<string>): { plan: ApplyPlanItem[]; blockers: string[] } {
  const blockers: string[] = [];
  const plan: ApplyPlanItem[] = [];
  for (const item of report.items) {
    if (item.area === 'manifest' && item.verdict === 'invalid') blockers.push(`manifest: ${item.detail}`);
    else if (item.area === 'mediaProfile' && item.verdict !== 'match') blockers.push(`media profile ${item.id}: ${item.detail}`);
    else if (item.area !== 'forms' && item.area !== 'manifest' && item.area !== 'mediaProfile' && (item.verdict === 'missing' || item.verdict === 'diverge')) {
      blockers.push(`catalog ${item.area}/${item.id} is ${item.verdict}: run the baseline seeds and migrations first`);
    } else if (item.area === 'forms') {
      if (item.verdict === 'match') plan.push({ propertyTypeCode: item.id, action: 'unchanged' });
      else if (item.verdict === 'missing') plan.push({ propertyTypeCode: item.id, action: 'create' });
      else if (item.verdict === 'diverge') {
        plan.push(allowPublish.has(item.id)
          ? { propertyTypeCode: item.id, action: 'publish-new-version', detail: item.detail }
          : { propertyTypeCode: item.id, action: 'refuse-divergence', detail: `${item.detail}; pass --allow-publish=${item.id} to publish a new version` });
      } else if (item.verdict === 'invalid') blockers.push(`form ${item.id}: ${item.detail}`);
    }
  }
  for (const item of plan) if (item.action === 'refuse-divergence') blockers.push(`form ${item.propertyTypeCode} diverges from the release`);
  return { plan, blockers };
}

const editable = (form: ManifestForm): FormFieldDto[] => form.content.fields.map((field) => {
  const { key, labelAr, labelEn, helpAr, helpEn, placeholderAr, required, order, operations, widget, validation, options } = field;
  return { key, labelAr, labelEn, helpAr, helpEn, placeholderAr, required, order, operations, widget, validation, options } as FormFieldDto;
});

export async function applyManifest(
  db: Db,
  service: AdminPropertyFormDefinitionsService,
  manifest: BaselineManifest,
  options: { dryRun: boolean; allowPublish?: readonly string[]; actorUserId: string },
): Promise<ApplyResult> {
  const preflight = manifestIntegrityProblems(manifest);
  if (preflight.length) throw new ManifestApplyError(`Manifest is not self-consistent: ${preflight.join('; ')}`);
  const report = await verifyAgainstManifest(db, manifest);
  const { plan, blockers } = planApply(report, new Set(options.allowPublish ?? []));
  const published: string[] = [];
  if (blockers.length || options.dryRun) return { dryRun: options.dryRun, ok: !blockers.length, blockers, plan, published, report };

  const actor = { userId: options.actorUserId };
  const types = new Map((await db.collection('property_types').find({}).toArray()).map((row) => [String(row.code), row]));
  for (const item of plan) {
    if (item.action !== 'create' && item.action !== 'publish-new-version') continue;
    const form = manifest.forms.find((entry) => entry.propertyTypeCode === item.propertyTypeCode)!;
    const type = types.get(item.propertyTypeCode);
    if (!type) throw new ManifestApplyError(`Unknown property type ${item.propertyTypeCode}`);
    const head = await db.collection('property_form_definitions').findOne({ purposeSubcategoryId: type._id });
    let detail = head ? await service.getDefinition(String(head._id)) : await service.createDefinition({ purposeSubcategoryId: String(type._id) }, actor);
    if (!detail.draft) detail = await service.createDraft(detail.definition.definitionId, { expectedVersion: detail.definition.version }, actor);
    const definitionId = detail.definition.definitionId;
    const saved = await service.updateDraft(definitionId, {
      expectedDraftRevision: detail.draft!.draftRevision, fields: editable(form), mediaProfile: form.content.mediaProfile,
      amenitiesEnabled: form.content.amenitiesEnabled,
      ...(form.content.allowedAmenityCodes !== undefined ? { allowedAmenityCodes: form.content.allowedAmenityCodes } : {}),
    }, actor);
    const validation = await service.validateDraft(definitionId);
    if (!validation.valid || validation.contentHash !== form.contentHash || computeFormContentHash(form.content) !== form.contentHash) {
      throw new ManifestApplyError(`Draft for ${item.propertyTypeCode} does not reproduce the release hash: ${JSON.stringify(validation.errors)}`);
    }
    await service.publish(definitionId, { expectedVersion: saved.definition.version, expectedDraftRevision: saved.draft!.draftRevision }, actor);
    published.push(item.propertyTypeCode);
  }
  const after = await verifyAgainstManifest(db, manifest);
  return { dryRun: false, ok: after.ok, blockers: after.ok ? [] : ['post-apply verification failed'], plan, published, report: after };
}
