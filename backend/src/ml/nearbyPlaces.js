import { calculateDistanceMeters } from '../db/index.js';

// Overpass is OpenStreetMap's free query API - same free/no-key data source
// the app already uses for map tiles (Leaflet) and geocoding (Nominatim).
const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const FETCH_TIMEOUT_MS = 8000;

// category key -> [human label, OSM tag filters to query for it]
const CATEGORIES = {
  park: { label: 'Park', filters: ['leisure=park', 'leisure=garden'] },
  cafe: { label: 'Cafe', filters: ['amenity=cafe'] },
  restaurant: { label: 'Restaurant', filters: ['amenity=restaurant', 'amenity=fast_food'] },
  supermarket: { label: 'Supermarket / Grocery', filters: ['shop=supermarket', 'shop=convenience'] },
  place_of_worship: { label: 'Place of Worship', filters: ['amenity=place_of_worship'] },
  community_centre: { label: 'Community Centre', filters: ['amenity=community_centre', 'amenity=social_facility'] },
  clinic: { label: 'Clinic / Pharmacy', filters: ['amenity=clinic', 'amenity=pharmacy', 'amenity=hospital'] },
  bus_station: { label: 'Bus Stop / Station', filters: ['highway=bus_stop', 'amenity=bus_station'] }
};

// Simple in-memory cache (rounded-coordinate key, 1 hour TTL) so repeated
// predictions for the same area don't hammer the free public Overpass instance.
const cache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;

function cacheKey(lat, lng, radiusMeters) {
  return `${lat.toFixed(3)},${lng.toFixed(3)},${radiusMeters}`;
}

function buildQuery(lat, lng, radiusMeters, categoryKeys) {
  const filters = categoryKeys.flatMap((key) => CATEGORIES[key]?.filters || []);
  const clauses = filters.map((f) => {
    const [tag, value] = f.split('=');
    return `  node["${tag}"="${value}"](around:${radiusMeters},${lat},${lng});`;
  }).join('\n');
  return `[out:json][timeout:15];\n(\n${clauses}\n);\nout center 30;`;
}

function tagsToCategory(tags) {
  for (const [key, def] of Object.entries(CATEGORIES)) {
    for (const filter of def.filters) {
      const [tag, value] = filter.split('=');
      if (tags[tag] === value) return { key, label: def.label };
    }
  }
  return { key: 'other', label: 'Place' };
}

/**
 * Queries OpenStreetMap (via Overpass) for real, named places of the given
 * categories within radiusMeters of (lat, lng). Returns [] (with `ok: false`)
 * on any network failure rather than throwing - callers must treat that as
 * "couldn't check" and say so, never as "confirmed nothing nearby".
 */
async function findNearbyPlaces(lat, lng, { radiusMeters = 800, limit = 8, categoryKeys = Object.keys(CATEGORIES) } = {}) {
  const key = cacheKey(lat, lng, radiusMeters) + ':' + categoryKeys.join(',');
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: buildQuery(lat, lng, radiusMeters, categoryKeys),
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
    const data = await res.json();

    const places = (data.elements || [])
      .filter((el) => el.tags?.name) // unnamed nodes aren't useful to show a caregiver
      .map((el) => {
        const placeLat = el.lat ?? el.center?.lat;
        const placeLng = el.lon ?? el.center?.lon;
        const { key: categoryKey, label } = tagsToCategory(el.tags);
        return {
          name: el.tags.name,
          category: categoryKey,
          categoryLabel: label,
          lat: placeLat,
          lng: placeLng,
          distanceMeters: Math.round(calculateDistanceMeters(lat, lng, placeLat, placeLng))
        };
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, limit);

    const result = { ok: true, places };
    cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    clearTimeout(timeout);
    console.error('Overpass lookup failed:', err.message);
    return { ok: false, places: [], error: err.message };
  }
}

/**
 * Finds the single nearest named real-world place to a learned stay-point,
 * so a prediction can say "Riverside Park" instead of "Learned location #2".
 * Returns null (not a fake name) if nothing named is found nearby or the
 * lookup fails - callers must fall back to a generic label, not guess.
 */
export async function nameForStayPoint(lat, lng, radiusMeters = 120) {
  const { ok, places } = await findNearbyPlaces(lat, lng, { radiusMeters, limit: 1 });
  if (!ok || places.length === 0) return null;
  return places[0];
}
