'use strict';

const {
  hasClearGovernorateConflict,
  isPointInsideEgypt,
} = require('../src/common/validators/egypt-location.validator');
describe('Egypt property location validation', () => {
  it('accepts points in Egypt and rejects invalid/outside points', () => {
    expect(isPointInsideEgypt(30.0444, 31.2357)).toBe(true);
    expect(isPointInsideEgypt(25.6872, 32.6396)).toBe(true);
    expect(isPointInsideEgypt(25.2048, 55.2708)).toBe(false);
    expect(isPointInsideEgypt(Number.NaN, 31)).toBe(false);
  });
  it('only reports an unambiguous governorate viewport conflict', () => {
    expect(hasClearGovernorateConflict(31.3, 32.3, 'cairo')).toBe(true);
    expect(hasClearGovernorateConflict(30.2, 31.2, 'cairo')).toBe(false);
    expect(hasClearGovernorateConflict(30.0444, 31.2357, 'unknown')).toBe(false);
  });
});
