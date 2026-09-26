import type { PropertyAttributeCrossFieldRule } from '../../../property-attributes/property-attribute.constants';

export type CrossFieldRule = {
  name: PropertyAttributeCrossFieldRule;
  /** The rule applies when the version contains every one of these keys. */
  keys: readonly string[];
  /** The field the error is reported on; the others are `relatedKeys`. */
  errorKey: string;
  holds(values: Readonly<Record<string, unknown>>): boolean;
};

/**
 * Engineering-owned cross-field rules (frozen §A1). Admin can neither author
 * nor disable them. A rule runs only when all its fields are provided and
 * passed their own checks.
 */
export const CROSS_FIELD_RULES: readonly CrossFieldRule[] = [
  {
    // Same rule the legacy write path enforces today (floor <= totalFloors).
    name: 'floorNotAboveTotalFloors',
    keys: ['floor', 'totalFloors'],
    errorKey: 'floor',
    holds: (values) => (values.floor as number) <= (values.totalFloors as number),
  },
];
