import {
  FormDraftErrorCode,
  buildDraftContent,
  canonicalField,
  diffFormContent,
  publishableContent,
  validateFormContent,
  type RegistryAttribute,
} from '../src/property-form-definitions/form-definition-drafts';
import {
  LEGACY_RESIDENTIAL_CONTENT,
  LEGACY_RESIDENTIAL_CONTENT_HASH,
  PROPERTY_FORM_LIMITS,
  computeFormContentHash,
  type FieldDefinition,
  type FormVersionContent,
} from '../src/property-form-definitions/property-form-definition.constants';
import { LEGACY_PROPERTY_ATTRIBUTE_SEED } from '../src/property-attributes/property-attribute.constants';
import { FIXTURE_ATTRIBUTES } from './support/form-admin-world';

/**
 * DPF-031/032 pure rules: every validation category per data type, the
 * registry boundary, canonical form and the deterministic diff.
 */

const REGISTRY = new Map<string, RegistryAttribute>([
  ...LEGACY_PROPERTY_ATTRIBUTE_SEED.map((seed) => [seed.key, { ...seed, status: 'active', origin: 'system' }] as [string, RegistryAttribute]),
  ...FIXTURE_ATTRIBUTES.map((entry) => [entry.key, entry as unknown as RegistryAttribute] as [string, RegistryAttribute]),
]);
const content = (fields: FieldDefinition[], extra: Partial<FormVersionContent> = {}): FormVersionContent => ({ rendererVersion: 1, fields, mediaProfile: 'generic', amenitiesEnabled: false, ...extra });
const field = (key: string, extra: Record<string, unknown> = {}): FieldDefinition => {
  const attribute = REGISTRY.get(key);
  return canonicalField({ key, dataType: attribute?.dataType, unit: attribute?.unit, optionSource: attribute?.optionSource, catalogGroup: attribute?.catalogGroup, labelAr: 'حقل', required: false, order: 1, ...extra } as FieldDefinition);
};
const errors = (fields: FieldDefinition[], extra: Partial<FormVersionContent> = {}, context = {}) =>
  validateFormContent(content(fields, extra), REGISTRY, context).map(({ code, fieldKey, property }) => [code, fieldKey ?? null, property ?? null]);

describe('form content validation', () => {
  it('accepts the seeded legacy residential form unchanged', () => {
    expect(validateFormContent(LEGACY_RESIDENTIAL_CONTENT, REGISTRY)).toEqual([]);
    expect(computeFormContentHash(publishableContent(LEGACY_RESIDENTIAL_CONTENT))).toBe(LEGACY_RESIDENTIAL_CONTENT_HASH);
  });

  it.each([
    ['integer bounds inside hard bounds', 'leaseTermYears', { validation: { min: 1, max: 99 } }, []],
    ['integer hard bounds must be stated', 'leaseTermYears', {}, [['BOUND_REQUIRED', 'validation.max'], ['BOUND_REQUIRED', 'validation.min']]],
    ['integer bound must be an integer', 'leaseTermYears', { validation: { min: 1.5, max: 99 } }, [['BOUND_INVALID', 'validation.min']]],
    ['integer bound as a string', 'leaseTermYears', { validation: { min: '1', max: 99 } }, [['BOUND_INVALID', 'validation.min']]],
    ['integer bound above the hard max', 'leaseTermYears', { validation: { min: 1, max: 100 } }, [['BOUND_OUTSIDE_REGISTRY', 'validation.max']]],
    ['decimal bounds and scale', 'roadWidth', { validation: { min: 0.5, max: 1000, scale: 2 } }, []],
    ['decimal scale above the registry', 'roadWidth', { validation: { min: 1, max: 2, scale: 3 } }, [['BOUND_OUTSIDE_REGISTRY', 'validation.scale']]],
    ['decimal registry scale must be stated', 'roadWidth', { validation: { min: 1, max: 2 } }, [['BOUND_REQUIRED', 'validation.scale']]],
    ['decimal non-finite bound', 'roadWidth', { validation: { min: Number.NaN, max: 2, scale: 1 } }, [['BOUND_INVALID', 'validation.min']]],
    ['min above max', 'roadWidth', { validation: { min: 5, max: 2, scale: 1 } }, [['BOUND_RANGE_INVALID', 'validation.min']]],
    ['text length bounds', 'notes', { validation: { minLength: 1, maxLength: 200 } }, []],
    ['text maxLength over the type cap', 'notes', { validation: { maxLength: 201 } }, [['BOUND_OUTSIDE_REGISTRY', 'validation.maxLength']]],
    ['text minLength above maxLength', 'notes', { validation: { minLength: 50, maxLength: 10 } }, [['BOUND_RANGE_INVALID', 'validation.minLength']]],
    ['textarea registry maxLength must be stated', 'description2', {}, [['BOUND_REQUIRED', 'validation.maxLength']]],
    ['textarea maxLength over the registry', 'description2', { validation: { maxLength: 501 } }, [['BOUND_OUTSIDE_REGISTRY', 'validation.maxLength']]],
    ['numeric rule on a text field', 'notes', { validation: { min: 1 } }, [['VALIDATION_NOT_APPLICABLE', 'validation.min']]],
    ['multiSelect item bounds', 'irrigationTypes', { validation: { minItems: 1, maxItems: 3 }, options: [{ code: 'drip', labelAr: 'تنقيط', order: 1 }, { code: 'flood', labelAr: 'غمر', order: 2 }, { code: 'pivot', labelAr: 'محوري', order: 3 }] }, []],
    ['multiSelect maxItems over the registry', 'irrigationTypes', { validation: { maxItems: 4 }, options: [{ code: 'drip', labelAr: 'تنقيط', order: 1 }] }, [['BOUND_OUTSIDE_REGISTRY', 'validation.maxItems']]],
    ['multiSelect registry maxItems must be stated', 'irrigationTypes', { options: [{ code: 'drip', labelAr: 'تنقيط', order: 1 }] }, [['BOUND_REQUIRED', 'validation.maxItems']]],
    ['multiSelect minItems above the offered options', 'irrigationTypes', { validation: { minItems: 2, maxItems: 3 }, options: [{ code: 'drip', labelAr: 'تنقيط', order: 1 }] }, [['BOUND_RANGE_INVALID', 'validation.minItems']]],
    ['date bounds', 'handoverDate', { validation: { min: '2000-01-01', max: '2100-01-01' } }, []],
    ['date registry minimum must be stated', 'handoverDate', {}, [['BOUND_REQUIRED', 'validation.min']]],
    ['date before the registry minimum', 'handoverDate', { validation: { min: '1999-12-31' } }, [['BOUND_OUTSIDE_REGISTRY', 'validation.min']]],
    ['not a calendar date', 'handoverDate', { validation: { min: '2001-02-30' } }, [['BOUND_INVALID', 'validation.min']]],
    ['boolean takes no rules', 'hasGarden', { validation: { min: 0 } }, [['VALIDATION_NOT_APPLICABLE', 'validation.min']]],
    ['boolean takes no widget', 'hasGarden', { widget: 'chips' }, [['WIDGET_UNSUPPORTED', 'widget']]],
    ['stepper on an integer', 'leaseTermYears', { widget: 'stepper', validation: { min: 1, max: 99 } }, []],
    ['stepper on a decimal', 'roadWidth', { widget: 'stepper', validation: { min: 1, max: 2, scale: 1 } }, [['WIDGET_UNSUPPORTED', 'widget']]],
    ['unknown widget', 'leaseTermYears', { widget: 'slider', validation: { min: 1, max: 99 } }, [['WIDGET_UNSUPPORTED', 'widget']]],
    ['catalog select takes no inline options', 'finishingStatus', { options: [{ code: 'x', labelAr: 'x', order: 1 }] }, [['OPTIONS_NOT_ALLOWED', 'options']]],
    ['inline select needs options', 'plotShape', {}, [['OPTIONS_COUNT_INVALID', 'options']]],
    ['option order must be unique', 'plotShape', { options: [{ code: 'regular', labelAr: 'أ', order: 1 }, { code: 'irregular', labelAr: 'ب', order: 1 }] }, [['OPTION_ORDER_DUPLICATE', 'options.irregular'], ['OPTION_ORDER_DUPLICATE', 'options.regular']]],
    ['operations must be a non-empty known set', 'hasGarden', { operations: [] }, [['OPERATIONS_INVALID', 'operations']]],
    ['duplicate operation', 'hasGarden', { operations: ['sale', 'sale'] }, [['OPERATIONS_INVALID', 'operations']]],
    ['label over the limit', 'hasGarden', { labelAr: 'ا'.repeat(81) }, [['LABEL_INVALID', 'labelAr']]],
    ['label with control characters', 'hasGarden', { labelAr: 'حديقة\u0000' }, [['LABEL_INVALID', 'labelAr']]],
    ['help over the limit', 'hasGarden', { helpEn: 'x'.repeat(301) }, [['LABEL_INVALID', 'helpEn']]],
    ['order out of range', 'hasGarden', { order: PROPERTY_FORM_LIMITS.fieldOrderMax + 1 }, [['PROPERTY_INVALID', 'order']]],
    ['required must be boolean', 'hasGarden', { required: 'yes' }, [['PROPERTY_INVALID', 'required']]],
  ])('%s', (_name, key, extra, expected) => {
    expect(errors([field(key as string, extra as Record<string, unknown>)]).map(([code, , property]) => [code, property])).toEqual(expected);
  });

  it('refuses an option carrying anything but code, labels and order', () => {
    const plot = { ...field('plotShape'), options: [{ code: 'regular', labelAr: 'أ', order: 1, status: 'active' }] } as unknown as FieldDefinition;
    expect(errors([plot])).toEqual([[FormDraftErrorCode.OPTION_INVALID, 'plotShape', 'options.regular']]);
  });

  it('enforces the registry identity: data type, unit, option source and catalog group come from the registry', () => {
    expect(errors([{ ...field('roadWidth', { validation: { min: 1, max: 2, scale: 1 } }), dataType: 'integer', unit: 'sqm' } as FieldDefinition])).toEqual([
      [FormDraftErrorCode.ATTRIBUTE_CONTRACT_MISMATCH, 'roadWidth', 'dataType'],
      [FormDraftErrorCode.ATTRIBUTE_CONTRACT_MISMATCH, 'roadWidth', 'unit'],
    ]);
    expect(errors([{ ...field('finishingStatus'), catalogGroup: 'delivery_status' } as FieldDefinition])).toEqual([[FormDraftErrorCode.ATTRIBUTE_CONTRACT_MISMATCH, 'finishingStatus', 'catalogGroup']]);
    expect(errors([{ ...field('hasGarden'), dataType: 'json' } as unknown as FieldDefinition]).map(([code]) => code)).toEqual([FormDraftErrorCode.ATTRIBUTE_CONTRACT_MISMATCH, FormDraftErrorCode.DATA_TYPE_UNSUPPORTED]);
  });

  it('never lets a form carry reserved V1 properties, denied or reserved keys, or unknown attributes', () => {
    for (const property of ['visibleWhen', 'regex', 'pattern', 'facet', 'indexed', 'searchable', 'filterable', 'sortable', 'default', 'sectionKey', 'dbField']) {
      expect(errors([{ ...field('hasGarden'), [property]: true } as FieldDefinition])).toEqual([[FormDraftErrorCode.FIELD_PROPERTY_UNSUPPORTED, 'hasGarden', property]]);
    }
    for (const key of ['constructor', 'toString', 'attributes', 'formDefinitionVersionId', 'Bad-Key']) {
      expect(errors([field(key)])).toEqual([[FormDraftErrorCode.ATTRIBUTE_KEY_RESERVED, key, 'key']]);
    }
    expect(errors([field('solarPanels')])).toEqual([[FormDraftErrorCode.ATTRIBUTE_UNKNOWN, 'solarPanels', 'key']]);
  });

  it('checks form-level rules: renderer version, media profile, amenities, field count and size caps', () => {
    const one = [field('hasGarden')];
    expect(errors(one, { rendererVersion: 2 })).toEqual([[FormDraftErrorCode.RENDERER_VERSION_UNSUPPORTED, null, 'rendererVersion']]);
    expect(errors(one, { mediaProfile: 'industrial' })).toEqual([[FormDraftErrorCode.MEDIA_PROFILE_UNSUPPORTED, null, 'mediaProfile']]);
    expect(errors(one, { amenitiesEnabled: 'yes' as unknown as boolean })).toEqual([[FormDraftErrorCode.PROPERTY_INVALID, null, 'amenitiesEnabled']]);
    const many = Array.from({ length: PROPERTY_FORM_LIMITS.maxFields + 1 }, (_, index) => ({ ...field('hasGarden'), key: `extra${index}`, order: index }));
    expect(errors(many).filter(([code]) => code !== FormDraftErrorCode.ATTRIBUTE_UNKNOWN)).toEqual([[FormDraftErrorCode.FIELDS_TOO_MANY, null, 'fields']]);
    const huge = field('plotShape', { options: Array.from({ length: 100 }, (_, index) => ({ code: 'regular', labelAr: 'ا'.repeat(80), labelEn: 'x'.repeat(80), order: index })) });
    expect(errors([huge]).map(([code]) => code)).toContain(FormDraftErrorCode.FIELD_TOO_LARGE);
    const heavy = Array.from({ length: 5 }, (_, index) => ({ ...huge, key: 'plotShape', order: index }));
    expect(validateFormContent(content(heavy), REGISTRY).find((error) => error.code === FormDraftErrorCode.VERSION_TOO_LARGE)).toMatchObject({ params: { max: PROPERTY_FORM_LIMITS.maxVersionBytes } });
  });

  it('lets a residential_rooms form omit any room-count attribute: the media profile never requires or injects specification fields', () => {
    const roomCounts = ['bedrooms', 'livingRooms', 'kitchens', 'bathrooms'];
    const withoutSome = LEGACY_RESIDENTIAL_CONTENT.fields.filter((item) => !['bedrooms', 'kitchens'].includes(item.key));
    expect(validateFormContent(content(withoutSome, { mediaProfile: 'residential_rooms', amenitiesEnabled: true }), REGISTRY)).toEqual([]);
    const withoutAny = LEGACY_RESIDENTIAL_CONTENT.fields.filter((item) => !roomCounts.includes(item.key));
    expect(validateFormContent(content(withoutAny, { mediaProfile: 'residential_rooms' }), REGISTRY)).toEqual([]);
    expect(validateFormContent(content([field('hasGarden')], { mediaProfile: 'residential_rooms' }), REGISTRY)).toEqual([]);
    // Building the draft adds nothing the Admin did not send.
    const built = buildDraftContent({ fields: [{ key: 'hasGarden', labelAr: 'حديقة', required: false, order: 1 }], mediaProfile: 'residential_rooms', amenitiesEnabled: true }, REGISTRY);
    expect(built.fields.map((item) => item.key)).toEqual(['hasGarden']);
  });

  it('allows an empty form as a draft but never for publication', () => {
    expect(validateFormContent(content([]), REGISTRY, { stage: 'draft' })).toEqual([]);
    expect(validateFormContent(content([]), REGISTRY)).toEqual([{ code: FormDraftErrorCode.FIELDS_EMPTY, property: 'fields', params: { min: 1 } }]);
    expect(validateFormContent(content([]), REGISTRY, { stage: 'publish' })).toEqual([{ code: FormDraftErrorCode.FIELDS_EMPTY, property: 'fields', params: { min: 1 } }]);
    expect(validateFormContent(content([field('hasGarden')]), REGISTRY)).toEqual([]);
  });

  it('reports duplicate keys and orders and never mutates its input', () => {
    const fields = [field('hasGarden', { order: 1 }), field('hasGarden', { order: 1 })];
    const snapshot = JSON.stringify(fields);
    expect(errors(fields)).toEqual([
      [FormDraftErrorCode.FIELD_KEY_DUPLICATE, 'hasGarden', 'key'],
      [FormDraftErrorCode.FIELD_ORDER_DUPLICATE, 'hasGarden', 'order'],
    ]);
    expect(JSON.stringify(fields)).toBe(snapshot);
  });

  it('allows a deprecated attribute or option only when the base version already used it', () => {
    const base = [field('oldFlag'), field('plotShape', { order: 2, options: [{ code: 'corner', labelAr: 'ناصية', order: 1 }] })];
    const draft = [field('oldFlag'), field('plotShape', { order: 2, options: [{ code: 'corner', labelAr: 'ناصية', order: 1 }] })];
    expect(errors(draft, {}, { baseFields: base })).toEqual([]);
    expect(errors(draft)).toEqual([
      [FormDraftErrorCode.ATTRIBUTE_DEPRECATED, 'oldFlag', 'key'],
      [FormDraftErrorCode.OPTION_DEPRECATED, 'plotShape', 'options.corner'],
    ]);
  });
});

describe('canonical content', () => {
  it('builds identity from the registry and canonicalizes labels, options and operations', () => {
    const built = buildDraftContent({
      fields: [
        { key: 'leaseTermYears', labelAr: ' مدة‮ ', required: false, order: 2, operations: ['rent', 'sale'], validation: { max: 10, min: 1 } },
        { key: 'plotShape', labelAr: 'شكل', labelEn: '', required: true, order: 1, operations: ['rent'], options: [{ code: 'irregular', order: 2 }, { code: 'regular', order: 1 }] },
      ],
      mediaProfile: 'generic',
      amenitiesEnabled: false,
    }, REGISTRY);
    expect(built.fields).toEqual([
      { key: 'plotShape', dataType: 'singleSelect', optionSource: 'inline', labelAr: 'شكل', required: true, order: 1, operations: ['rent'], options: [{ code: 'regular', labelAr: 'منتظم', order: 1 }, { code: 'irregular', labelAr: 'غير منتظم', order: 2 }] },
      { key: 'leaseTermYears', dataType: 'integer', labelAr: 'مدة', required: false, order: 2, validation: { max: 10, min: 1 } },
    ]);
  });

  it('hashes the same form identically regardless of key order', () => {
    const a = content([field('leaseTermYears', { validation: { min: 1, max: 9 } })]);
    const b = content([JSON.parse(JSON.stringify({ validation: { max: 9, min: 1 }, order: 1, required: false, labelAr: 'حقل', dataType: 'integer', key: 'leaseTermYears' }))]);
    expect(computeFormContentHash(publishableContent(a))).toBe(computeFormContentHash(publishableContent(b)));
    expect(diffFormContent(a, b).hasChanges).toBe(false);
  });
});

describe('diff', () => {
  const before = content([field('hasGarden', { order: 1 }), field('leaseTermYears', { order: 2, validation: { min: 1, max: 99 } })]);

  it('is empty for identical content and sorted for changes', () => {
    expect(diffFormContent(before, before)).toEqual({ hasChanges: false, form: [], fieldsAdded: [], fieldsRemoved: [], fieldsChanged: [] });
    const after = content([field('leaseTermYears', { order: 1, required: true, validation: { min: 2, max: 99 } }), field('notes', { order: 3 })], { amenitiesEnabled: true });
    const diff = diffFormContent(before, after);
    expect(diff.form).toEqual([{ property: 'amenitiesEnabled', before: false, after: true }]);
    expect(diff.fieldsAdded.map((item) => item.key)).toEqual(['notes']);
    expect(diff.fieldsRemoved.map((item) => item.key)).toEqual(['hasGarden']);
    expect(diff.fieldsChanged).toEqual([{ key: 'leaseTermYears', changes: [
      { property: 'order', before: 2, after: 1 },
      { property: 'required', before: false, after: true },
      { property: 'validation.min', before: 1, after: 2 },
    ] }]);
    // Deterministic: the same inputs always give the same output.
    expect(JSON.stringify(diffFormContent(before, after))).toBe(JSON.stringify(diff));
  });

  it('reports a renamed key as a removal plus an addition, never a rename', () => {
    const diff = diffFormContent(before, content([field('hasWaterAccess', { order: 1 }), field('leaseTermYears', { order: 2, validation: { min: 1, max: 99 } })]));
    expect(diff.fieldsRemoved.map((item) => item.key)).toEqual(['hasGarden']);
    expect(diff.fieldsAdded.map((item) => item.key)).toEqual(['hasWaterAccess']);
    expect(diff.fieldsChanged).toEqual([]);
  });

  it('reports a renderer version change', () => {
    expect(diffFormContent({ ...before, rendererVersion: 0 } as FormVersionContent, before).form).toEqual([{ property: 'rendererVersion', before: 0, after: 1 }]);
  });
});
