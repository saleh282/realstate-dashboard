'use strict';

const { isPointInsideEgypt } = require('../../common/validators/egypt-location.validator');
const { normalizeContactPhone } = require('../../common/validators/identifier.validator');
const {
  ListingCategory,
  ListingPurpose,
  SUBTYPES,
  AMENITIES,
  AreaUnit,
  SQM_PER_FEDDAN,
  FINISHINGS,
  LEGAL_STATUSES,
  WATER_SOURCES,
  PAYMENT_METHODS,
  RENT_PERIODS,
} = require('../../domain/listings/listing.types');

const REQUIRED = 'هذا الحقل مطلوب';
const NUMBER = 'أدخل رقماً صحيحاً';
const CHOICE = 'اختيار غير صحيح';

const present = (value) => value !== undefined && value !== null && value !== '';

/**
 * Checks the data of a listing as the advertiser sends it and returns it
 * cleaned. Fields that do not apply to the category or purpose are dropped,
 * so a client may always send everything it has.
 *
 * Returns `{ value, errors }`; `errors` maps a field to its Arabic message and
 * is empty when the listing is acceptable.
 */
function validateListing(input, now = new Date()) {
  const body = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const value = {};
  const errors = {};
  const fail = (field, message) => {
    errors[field] ??= message;
  };

  const text = (field, { min = 0, max, required = false }) => {
    const raw = body[field];
    if (!present(raw) || (typeof raw === 'string' && !raw.trim())) {
      if (required) fail(field, REQUIRED);
      return;
    }
    if (typeof raw !== 'string') return fail(field, 'نص غير صحيح');
    const trimmed = raw.trim();
    if (trimmed.length < min) return fail(field, 'النص قصير جداً');
    if (trimmed.length > max) return fail(field, 'النص طويل جداً');
    value[field] = trimmed;
  };
  const number = (
    field,
    { source = body, required = false, integer = false, min, max, into = value },
  ) => {
    const raw = source[field];
    if (!present(raw)) {
      if (required) fail(field, REQUIRED);
      return undefined;
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || (integer && !Number.isInteger(raw))) {
      fail(field, NUMBER);
      return undefined;
    }
    if ((min !== undefined && raw < min) || (max !== undefined && raw > max)) {
      fail(field, NUMBER);
      return undefined;
    }
    into[field] = raw;
    return raw;
  };
  const positive = (field, options = {}) => {
    const result = number(field, options);
    if (result !== undefined && result <= 0) {
      delete (options.into ?? value)[field];
      fail(field, NUMBER);
      return undefined;
    }
    return result;
  };
  const choice = (field, allowed, { required = false } = {}) => {
    const raw = body[field];
    if (!present(raw)) {
      if (required) fail(field, REQUIRED);
      return undefined;
    }
    if (!allowed.includes(raw)) {
      fail(field, CHOICE);
      return undefined;
    }
    value[field] = raw;
    return raw;
  };
  const flag = (field, fallback) => {
    const raw = body[field];
    if (!present(raw)) return (value[field] = fallback);
    if (typeof raw !== 'boolean') {
      fail(field, CHOICE);
      return fallback;
    }
    return (value[field] = raw);
  };

  // What is offered.
  const category = choice('category', Object.values(ListingCategory), { required: true });
  const purpose = choice('purpose', Object.values(ListingPurpose), { required: true });
  const subtype = choice('subtype', category ? SUBTYPES[category] : [], { required: true });
  const residential = category === ListingCategory.RESIDENTIAL;
  const commercial = category === ListingCategory.COMMERCIAL;
  const industrial = category === ListingCategory.INDUSTRIAL;
  const land = category === ListingCategory.LAND;
  const agricultural = land && subtype === 'agricultural';

  // Its description.
  text('titleAr', { min: 5, max: 150, required: true });
  text('titleEn', { min: 5, max: 150 });
  text('descriptionAr', { min: 20, max: 3000, required: true });
  text('descriptionEn', { min: 20, max: 3000 });

  const area = positive('area', { required: true });
  // Only farmland is measured in feddans.
  const areaUnit = agricultural
    ? (choice('areaUnit', Object.values(AreaUnit)) ?? AreaUnit.SQM)
    : AreaUnit.SQM;
  value.areaUnit = areaUnit;
  if (area !== undefined) {
    value.areaSqm = areaUnit === AreaUnit.FEDDAN ? area * SQM_PER_FEDDAN : area;
  }
  choice('legalStatus', LEGAL_STATUSES);

  if (residential) {
    number('bedrooms', { required: true, integer: true, min: 0, max: 50 });
    number('bathrooms', { required: true, integer: true, min: 0, max: 50 });
  }
  if (commercial) number('bathrooms', { integer: true, min: 0, max: 50 });
  if (residential || commercial) {
    choice('finishing', FINISHINGS, { required: true });
    const floor = number('floor', { integer: true, min: -5, max: 200 });
    if (residential) {
      const totalFloors = number('totalFloors', { integer: true, min: 1, max: 200 });
      if (floor !== undefined && totalFloors !== undefined && floor > totalFloors) {
        fail('totalFloors', 'الدور أكبر من عدد الأدوار');
      }
      const year = number('buildingYear', { integer: true });
      if (year !== undefined && (year < 1900 || year > now.getFullYear() + 5)) {
        delete value.buildingYear;
        fail('buildingYear', 'أدخل سنة صحيحة');
      }
    }
  }
  if (commercial || land) positive('frontage');
  if (industrial) {
    positive('builtArea');
    positive('ceilingHeight');
    positive('powerKw');
    flag('hasOperatingLicence', false);
  }
  if (land) number('streets', { integer: true, min: 1, max: 4 });
  if (agricultural) choice('waterSource', WATER_SOURCES);

  const amenities = body.amenities;
  if (present(amenities)) {
    const allowed = category ? AMENITIES[category] : [];
    if (!Array.isArray(amenities) || amenities.some((item) => !allowed.includes(item))) {
      fail('amenities', CHOICE);
    } else {
      value.amenities = [...new Set(amenities)];
    }
  } else {
    value.amenities = [];
  }

  // Where it is.
  const { latitude, longitude } = body;
  if (!present(latitude) || !present(longitude)) {
    fail('location', 'حدد موقع العقار على الخريطة');
  } else if (!isPointInsideEgypt(latitude, longitude)) {
    fail('location', 'الموقع يجب أن يكون داخل مصر');
  } else {
    value.location = { type: 'Point', coordinates: [longitude, latitude] };
  }
  text('governorate', { max: 80, required: true });
  text('city', { max: 80 });
  text('district', { max: 120, required: true });
  text('street', { max: 160 });
  text('addressDetails', { max: 300 });

  // What it costs.
  const price = positive('price', { required: true, integer: true });
  flag('negotiable', false);
  if (purpose === ListingPurpose.SALE) {
    const method = choice('paymentMethod', PAYMENT_METHODS, { required: true });
    if (method && method !== 'cash') {
      const down = positive('downPayment', { integer: true });
      if (down !== undefined && price !== undefined && down >= price) {
        delete value.downPayment;
        fail('downPayment', 'المقدم يجب أن يكون أقل من السعر');
      }
    }
  }
  if (purpose === ListingPurpose.RENT) {
    choice('rentPeriod', RENT_PERIODS, { required: true });
    if (residential || commercial) {
      if (!present(body.furnished)) fail('furnished', REQUIRED);
      else flag('furnished', false);
    }
    positive('deposit', { integer: true });
    positive('minContractMonths', { integer: true });
  }
  if (purpose === ListingPurpose.TRANSFER) {
    const source = body.transfer && typeof body.transfer === 'object' ? body.transfer : {};
    const transfer = {};
    positive('monthlyInstallment', { source, into: transfer, required: true, integer: true });
    const total = number('totalYears', { source, into: transfer, required: true, integer: true });
    if (total !== undefined && (total < 1 || total > 40)) {
      delete transfer.totalYears;
      fail('totalYears', 'أدخل مدة من 1 إلى 40 سنة');
    }
    const paid = number('paidYears', {
      source,
      into: transfer,
      required: true,
      integer: true,
      min: 0,
    });
    if (paid !== undefined && total !== undefined && paid >= total) {
      delete transfer.paidYears;
      fail('paidYears', 'المدة المسددة يجب أن تكون أقل من الإجمالي');
    }
    if (present(source.developer)) {
      if (typeof source.developer !== 'string' || source.developer.trim().length > 120) {
        fail('developer', 'النص طويل جداً');
      } else if (source.developer.trim()) {
        transfer.developer = source.developer.trim();
      }
    }
    value.transfer = transfer;
  }

  // How buyers reach the advertiser.
  const phone = body.contactPhone;
  if (!present(phone)) {
    fail('contactPhone', REQUIRED);
  } else {
    const normalized = typeof phone === 'string' ? normalizeContactPhone(phone) : null;
    if (normalized) value.contactPhone = normalized;
    else fail('contactPhone', 'أدخل رقم موبايل صحيح');
  }
  const showPhone = flag('showPhone', true);
  const allowWhatsapp = flag('allowWhatsapp', true);
  if (!showPhone && !allowWhatsapp) fail('contact', 'اختر وسيلة تواصل واحدة على الأقل');

  return { value, errors };
}

module.exports = { validateListing };
