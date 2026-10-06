'use strict';

const { requiredShots } = require('../domain/listings/photo-shots');

const idOf = (value) => (value === undefined || value === null ? undefined : String(value));

/** Photos in the order they are shown: the required shots, then the extras. */
function orderedPhotos(listing) {
  const photos = listing.photos ?? [];
  const shots = requiredShots(listing);
  const required = shots.map((shot) => photos.find((photo) => photo.shot === shot)).filter(Boolean);
  const extras = photos
    .filter((photo) => !photo.shot || !shots.includes(photo.shot))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return [...required, ...extras].map((photo) => ({
    id: idOf(photo._id),
    url: photo.url,
    ...(photo.shot ? { shot: photo.shot } : {}),
  }));
}

function missingShots(listing) {
  const have = new Set((listing.photos ?? []).map((photo) => photo.shot).filter(Boolean));
  return requiredShots(listing).filter((shot) => !have.has(shot));
}

const DATA_FIELDS = [
  'category',
  'purpose',
  'subtype',
  'titleAr',
  'titleEn',
  'descriptionAr',
  'descriptionEn',
  'area',
  'areaUnit',
  'bedrooms',
  'bathrooms',
  'floor',
  'totalFloors',
  'buildingYear',
  'finishing',
  'frontage',
  'builtArea',
  'ceilingHeight',
  'powerKw',
  'hasOperatingLicence',
  'streets',
  'waterSource',
  'legalStatus',
  'amenities',
  'governorate',
  'city',
  'district',
  'street',
  'addressDetails',
  'price',
  'negotiable',
  'paymentMethod',
  'downPayment',
  'rentPeriod',
  'furnished',
  'deposit',
  'minContractMonths',
];

function base(listing) {
  const view = { id: idOf(listing._id) };
  for (const field of DATA_FIELDS) {
    if (listing[field] !== undefined && listing[field] !== null) view[field] = listing[field];
  }
  const [longitude, latitude] = listing.location?.coordinates ?? [];
  view.latitude = latitude;
  view.longitude = longitude;
  if (listing.transfer) {
    const { monthlyInstallment, totalYears, paidYears, remainingYears, developer } =
      listing.transfer;
    view.transfer = {
      monthlyInstallment,
      totalYears,
      paidYears,
      remainingYears,
      ...(developer ? { developer } : {}),
    };
  }
  view.photos = orderedPhotos(listing);
  view.videoUrl = listing.video?.url ?? null;
  view.contactPhone = listing.contactPhone;
  view.showPhone = listing.showPhone !== false;
  view.allowWhatsapp = listing.allowWhatsapp !== false;
  return view;
}

/** Everything its owner needs, with where it stands in the review. */
function ownerListing(listing) {
  return {
    ...base(listing),
    status: listing.status,
    version: listing.version,
    missingShots: missingShots(listing),
    rejectionReason: listing.rejectionReason ?? null,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    submittedAt: listing.submittedAt ?? null,
    publishedAt: listing.publishedAt ?? null,
    closedAt: listing.closedAt ?? null,
  };
}

/** Who posted a listing, as buyers see them. */
function advertiser(user) {
  if (!user) return null;
  return {
    id: idOf(user._id),
    name: user.fullName,
    photoUrl: user.profilePhoto?.secureUrl ?? null,
    verified: user.verificationTrustState === 'VERIFIED',
  };
}

/** A published listing as anyone may see it. */
function publicListing(listing, owner) {
  return {
    ...base(listing),
    publishedAt: listing.publishedAt ?? null,
    advertiser: advertiser(owner),
    ...(typeof listing.distanceMeters === 'number'
      ? { distanceKm: Math.round(listing.distanceMeters / 100) / 10 }
      : {}),
  };
}

/** A listing in the review queue: what its owner sees, plus who they are. */
function reviewListing(listing, owner) {
  return {
    ...ownerListing(listing),
    owner: owner
      ? {
          ...advertiser(owner),
          email: owner.email ?? null,
          phone: owner.phone ?? null,
          accountType: owner.accountType ?? null,
        }
      : null,
    reviewedAt: listing.reviewedAt ?? null,
  };
}

/** The little a map marker needs. */
function mapPoint(listing) {
  const [longitude, latitude] = listing.location?.coordinates ?? [];
  return {
    id: idOf(listing._id),
    latitude,
    longitude,
    price: listing.price,
    purpose: listing.purpose,
    category: listing.category,
  };
}

module.exports = {
  DATA_FIELDS,
  orderedPhotos,
  missingShots,
  ownerListing,
  publicListing,
  reviewListing,
  mapPoint,
};
