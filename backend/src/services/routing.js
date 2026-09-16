// OSRM (Open Source Routing Machine) public demo server - free, no API key,
// same free OpenStreetMap ecosystem already used for maps/geocoding/places
// elsewhere in this app. Used for a quick in-app route PREVIEW only - real
// turn-by-turn walking navigation is handed off to Google Maps instead (see
// the "Navigate Home" button), since that has live rerouting and voice
// guidance this preview intentionally doesn't try to replicate.
const OSRM_BASE_URL = 'https://router.project-osrm.org/route/v1/foot';
const FETCH_TIMEOUT_MS = 8000;

/**
 * Returns a walking route from (fromLat, fromLng) to (toLat, toLng):
 * an array of [lat, lng] points to draw, plus total distance/duration.
 * Returns { ok: false, error } on any failure - never throws, never
 * fabricates a route - so the caller can show an honest fallback message.
 */
export async function getWalkingRoute(fromLat, fromLng, toLat, toLng) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    // OSRM expects lng,lat order (GeoJSON convention), not lat,lng.
    const url = `${OSRM_BASE_URL}/${fromLng},${fromLat};${toLng},${toLat}?overview=full&geometries=geojson`;
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`OSRM returned HTTP ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok' || !data.routes?.length) {
      throw new Error(data.message || 'No walking route could be found between these points');
    }

    const route = data.routes[0];
    // GeoJSON coordinates are [lng, lat] - flip to [lat, lng] for Leaflet.
    const coordinates = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

    return {
      ok: true,
      coordinates,
      distanceMeters: Math.round(route.distance),
      durationSeconds: Math.round(route.duration)
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error('OSRM route lookup failed:', err.message);
    return { ok: false, error: err.message };
  }
}
