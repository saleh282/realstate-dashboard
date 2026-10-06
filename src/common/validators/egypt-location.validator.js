'use strict';

// Coarse national boundary used as a server-side sanity check. It deliberately
// excludes the large bounding-box corners that are sea or neighboring states.
const EGYPT_OUTLINE = [
  { latitude: 31.67, longitude: 25.0 },
  { latitude: 31.67, longitude: 31.55 },
  { latitude: 31.33, longitude: 32.35 },
  { latitude: 31.1, longitude: 34.22 },
  { latitude: 29.5, longitude: 34.9 },
  { latitude: 27.7, longitude: 34.3 },
  { latitude: 22.0, longitude: 36.9 },
  { latitude: 22.0, longitude: 25.0 },
];
function isPointInsideEgypt(latitude, longitude) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  let inside = false;
  for (let i = 0, j = EGYPT_OUTLINE.length - 1; i < EGYPT_OUTLINE.length; j = i++) {
    const a = EGYPT_OUTLINE[i];
    const b = EGYPT_OUTLINE[j];
    const crosses =
      a.latitude > latitude !== b.latitude > latitude &&
      longitude <
        ((b.longitude - a.longitude) * (latitude - a.latitude)) / (b.latitude - a.latitude) +
          a.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

module.exports = { isPointInsideEgypt };
