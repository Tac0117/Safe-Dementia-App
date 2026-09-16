import { Router } from 'express';
import { db, calculateDistanceMeters } from '../db/index.js';
import { requireAuth, requireLinkedPatient } from '../auth/middleware.js';
import { maybeRetrain } from '../ml/trainer.js';
import { getWalkingRoute } from '../services/routing.js';

const router = Router();

async function geocodeAddress(addressStr) {
    try {
        const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressStr)}`);
        const data = await res.json();
        if (data && data.length > 0) {
            return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), displayName: data[0].display_name };
        }
    } catch (err) {
        console.error('Geocoding error:', err);
    }
    return null;
}

function getPatientFull(patientId) {
    const user = db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(patientId);
    const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);
    if (!user || !profile) return null;
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        age: profile.age,
        condition: profile.condition,
        emergencyPhone: profile.emergency_phone,
        isMissing: !!profile.is_missing,
        missingSince: profile.missing_since,
        currentLocation: {
            lat: profile.current_lat,
            lng: profile.current_lng,
            address: profile.current_address,
            timestamp: profile.location_updated_at
        },
        safeZone: {
            center: { lat: profile.home_lat, lng: profile.home_lng },
            address: profile.home_address,
            radiusMeters: profile.safe_radius_meters,
            enabled: !!profile.safe_zone_enabled
        }
    };
}

router.get('/:patientId', requireAuth, requireLinkedPatient, (req, res) => {
    const patient = getPatientFull(Number(req.params.patientId));
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json(patient);
});

router.post('/:patientId/profile', requireAuth, requireLinkedPatient, async (req, res) => {
    const patientId = Number(req.params.patientId);
    const { age, condition, emergencyPhone, address, homeCenter, safeRadiusMeters, name } = req.body;

    if (name && name.trim()) {
        db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(name.trim(), patientId);
    }

    let coords = homeCenter;
    let resolvedAddress = address;
    if (address && (!coords || !coords.lat)) {
        const geoResult = await geocodeAddress(address);
        if (geoResult) {
            coords = { lat: geoResult.lat, lng: geoResult.lng };
            resolvedAddress = geoResult.displayName;
        }
    }

    const current = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);

    db.prepare(
        `UPDATE patient_profiles SET
      age = COALESCE(?, age),
      condition = COALESCE(?, condition),
      emergency_phone = COALESCE(?, emergency_phone),
      home_lat = COALESCE(?, home_lat),
      home_lng = COALESCE(?, home_lng),
      home_address = COALESCE(?, home_address),
      safe_radius_meters = COALESCE(?, safe_radius_meters),
      current_lat = COALESCE(?, current_lat),
      current_lng = COALESCE(?, current_lng),
      current_address = COALESCE(?, current_address)
     WHERE patient_id = ?`
    ).run(
        age ? Number(age) : null,
        condition || null,
        emergencyPhone || null,
        coords?.lat ? Number(coords.lat) : null,
        coords?.lng ? Number(coords.lng) : null,
        resolvedAddress || null,
        safeRadiusMeters ? Number(safeRadiusMeters) : null,
        // if home moved and patient has no location yet, seed current location to home
        !current?.current_lat && coords?.lat ? Number(coords.lat) : null,
        !current?.current_lng && coords?.lng ? Number(coords.lng) : null,
        !current?.current_address && resolvedAddress ? resolvedAddress : null,
        patientId
    );

    res.json({ success: true, patient: getPatientFull(patientId) });
});


// Debounce window for geofence breaches: require the patient to be outside
// the safe zone for this many consecutive pings before flipping isMissing.
// A single stray GPS reading near the boundary should not trigger an alert.
const BREACH_CONFIRMATION_COUNT = 3;

router.post('/:patientId/location', requireAuth, requireLinkedPatient, (req, res) => {
    const patientId = Number(req.params.patientId);
    const { lat, lng, address } = req.body;
    if (lat === undefined || lng === undefined) return res.status(400).json({ error: 'lat/lng required' });

    const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);
    const timestamp = new Date().toISOString();
    const resolvedAddress = address || `${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}`;

    let status = 'Inside Safe Zone';
    let distance = null;
    let isMissing = !!profile.is_missing;

    if (profile.safe_zone_enabled && profile.home_lat != null) {
        distance = calculateDistanceMeters(Number(lat), Number(lng), profile.home_lat, profile.home_lng);
        const outsideNow = distance > profile.safe_radius_meters;

        if (outsideNow) {
            status = `Outside safe zone (${Math.round(distance)}m away)`;
            // Count consecutive outside readings (most recent first) to debounce GPS jitter.
            const recent = db
                .prepare(`SELECT status FROM location_history WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?`)
                .all(patientId, BREACH_CONFIRMATION_COUNT - 1);
            // Note: recent.every(...) on an empty array is vacuously true, so we
            // also require a full window of prior readings — otherwise the very
            // first-ever ping outside the zone would wrongly count as "confirmed".
            const consecutiveOutside =
                recent.length === BREACH_CONFIRMATION_COUNT - 1 &&
                recent.every((r) => r.status && r.status.startsWith('Outside'));
            if (consecutiveOutside) {
                if (!isMissing) {
                    db.prepare(`UPDATE patient_profiles SET missing_since = ? WHERE patient_id = ?`).run(timestamp, patientId);
                    db.prepare(
                        `INSERT INTO emergency_events (patient_id, trigger_type, lat, lng, address, distance_from_home_m)
             VALUES (?, 'geofence_breach', ?, ?, ?, ?)`
                    ).run(patientId, Number(lat), Number(lng), resolvedAddress, distance);
                }
                isMissing = true;
            }
        } else {
            status = 'Inside safe zone';
            if (isMissing) {
                db.prepare(
                    `UPDATE emergency_events SET status = 'resolved', resolved_at = ? WHERE patient_id = ? AND status = 'active'`
                ).run(timestamp, patientId);
            }
            isMissing = false;
        }
    }

    db.prepare(
        `UPDATE patient_profiles SET
      current_lat = ?, current_lng = ?, current_address = ?,
      location_updated_at = ?, is_missing = ?, missing_since = ?
     WHERE patient_id = ?`
    ).run(
        Number(lat), Number(lng), resolvedAddress,
        timestamp, isMissing ? 1 : 0, isMissing ? (profile.missing_since || timestamp) : null,
        patientId
    );

    db.prepare(
        `INSERT INTO location_history (patient_id, lat, lng, address, status, distance_from_home_m)
     VALUES (?, ?, ?, ?, ?, ?)`
    ).run(patientId, Number(lat), Number(lng), resolvedAddress, status, distance);

    // Fire-and-forget: retrain the patient's personalized location model once
    // enough new pings have accumulated. Never blocks the location-update response.
    maybeRetrain(patientId).catch((err) => console.error('Retrain check failed:', err));

    res.json({ success: true, currentLocation: getPatientFull(patientId).currentLocation, isMissing, status });
});

router.get('/:patientId/location-history', requireAuth, requireLinkedPatient, (req, res) => {
    const patientId = Number(req.params.patientId);
    const rows = db
        .prepare(`SELECT lat, lng, address, status, strftime('%Y-%m-%dT%H:%M:%fZ', created_at) as timestamp FROM location_history WHERE patient_id = ? ORDER BY created_at DESC LIMIT 50`)
        .all(patientId);
    res.json(rows);
});

// Quick in-app route PREVIEW (line + distance/time estimate) from the
// patient's current location to home. Real turn-by-turn navigation is
// handled by the "Navigate Home" button linking out to Google Maps instead -
// this is just a same-screen glance, so it degrades honestly (ok: false) if
// the free routing service can't be reached, rather than showing nothing or
// a fake route.
router.get('/:patientId/route-home', requireAuth, requireLinkedPatient, async (req, res) => {
    const patientId = Number(req.params.patientId);
    const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);

    if (!profile?.current_lat) return res.status(400).json({ error: 'No current location on file for this patient yet' });
    if (!profile?.home_lat) return res.status(400).json({ error: 'No home address set for this patient yet' });

    const result = await getWalkingRoute(profile.current_lat, profile.current_lng, profile.home_lat, profile.home_lng);
    res.json(result);
});

export default router;