'use strict';

const SHOTS = Object.freeze({
  residential: ['facade', 'reception', 'bedroom', 'kitchen', 'bathroom', 'view'],
  commercial: ['facade', 'entrance', 'interior', 'bathroom', 'street'],
  industrial: ['facade', 'hall', 'loading', 'power', 'offices'],
  land: ['facade', 'borders', 'road', 'landmark'],
});

/**
 * The photos a listing must have before it can be sent for review, in the
 * order they are shown. The first one, the facade, is the cover.
 */
function requiredShots(listing) {
  const shots = SHOTS[listing.category] ?? [];
  // A shop or office with no bathroom has none to photograph.
  if (listing.category === 'commercial' && !(listing.bathrooms > 0)) {
    return shots.filter((shot) => shot !== 'bathroom');
  }
  return [...shots];
}

/** Every shot name any category knows, to recognise one in a URL. */
const ALL_SHOTS = Object.freeze([...new Set(Object.values(SHOTS).flat())]);

module.exports = { requiredShots, ALL_SHOTS };
