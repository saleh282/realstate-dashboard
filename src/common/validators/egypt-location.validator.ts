import { DEFAULT_GOVERNORATE_MAP_VIEWPORTS } from '../../governorates/governorate.constants';

type Point = { latitude: number; longitude: number };

// Coarse national boundary used as a server-side sanity check. It deliberately
// excludes the large bounding-box corners that are sea or neighboring states.
const EGYPT_OUTLINE: Point[] = [
  { latitude: 31.67, longitude: 25.0 }, { latitude: 31.67, longitude: 31.55 },
  { latitude: 31.33, longitude: 32.35 }, { latitude: 31.1, longitude: 34.22 },
  { latitude: 29.5, longitude: 34.9 }, { latitude: 27.7, longitude: 34.3 },
  { latitude: 22.0, longitude: 36.9 }, { latitude: 22.0, longitude: 25.0 },
];

export function isPointInsideEgypt(latitude: number, longitude: number): boolean {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
  let inside = false;
  for (let i = 0, j = EGYPT_OUTLINE.length - 1; i < EGYPT_OUTLINE.length; j = i++) {
    const a = EGYPT_OUTLINE[i];
    const b = EGYPT_OUTLINE[j];
    const crosses = (a.latitude > latitude) !== (b.latitude > latitude)
      && longitude < (b.longitude - a.longitude) * (latitude - a.latitude)
        / (b.latitude - a.latitude) + a.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

function inViewport(point: Point, code: string): boolean {
  const viewport = DEFAULT_GOVERNORATE_MAP_VIEWPORTS[code];
  if (!viewport) return false;
  return point.latitude >= viewport.bounds.southWest.latitude
    && point.latitude <= viewport.bounds.northEast.latitude
    && point.longitude >= viewport.bounds.southWest.longitude
    && point.longitude <= viewport.bounds.northEast.longitude;
}

/**
 * Viewports are display bounds, not legal boundaries. Only report a conflict
 * when the point is outside the selected viewport and falls unambiguously in
 * exactly one other catalog viewport; ambiguous/edge points remain allowed.
 */
export function hasClearGovernorateConflict(latitude: number, longitude: number, selectedCode: string): boolean {
  const point = { latitude, longitude };
  if (!DEFAULT_GOVERNORATE_MAP_VIEWPORTS[selectedCode] || inViewport(point, selectedCode)) return false;
  const matches = Object.keys(DEFAULT_GOVERNORATE_MAP_VIEWPORTS).filter((code) => inViewport(point, code));
  return matches.length === 1 && matches[0] !== selectedCode;
}
