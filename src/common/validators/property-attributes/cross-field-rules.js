'use strict';

/**
 * Engineering-owned cross-field rules (frozen §A1). Admin can neither author
 * nor disable them. A rule runs only when all its fields are provided and
 * passed their own checks.
 */
const CROSS_FIELD_RULES = [
  {
    // Same rule the legacy write path enforces today (floor <= totalFloors).
    name: 'floorNotAboveTotalFloors',
    keys: ['floor', 'totalFloors'],
    errorKey: 'floor',
    holds: (values) => values.floor <= values.totalFloors,
  },
];

Object.assign(exports, { CROSS_FIELD_RULES });
