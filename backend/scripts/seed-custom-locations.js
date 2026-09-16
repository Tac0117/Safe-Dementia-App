#!/usr/bin/env node
/**
 * Seeds MANUALLY-SPECIFIED location pings with real, geocoded addresses and
 * exact dates/times you choose yourself - for when you want full control
 * over test data instead of the randomized routine in seed-test-data.js.
 *
 * USAGE:
 *   node scripts/seed-custom-locations.js <patient-email> <path-to-json-file>
 *
 * Example:
 *   node scripts/seed-custom-locations.js arthur@example.com scripts/custom-locations-example.json
 *
 * The JSON file is a plain array of entries:
 *   { "date": "YYYY-MM-DD", "time": "HH:MM", "address": "a real, specific address" }
 *
 * Each address is looked up for its REAL coordinates via OpenStreetMap's free
 * geocoder (Nominatim) - the exact same service the rest of the app already
 * uses for address search (see EditProfileModal.jsx) - so what ends up in
 * the Location Log is a real place with real coordinates, not an approximated
 * offset. The more specific the address string, the better the match - e.g.
 * "Publika Shopping Gallery, Kuala Lumpur, Malaysia" works much better than
 * just "shopping mall".
 *
 * If you already know exact coordinates for an entry (e.g. you dropped a pin
 * on Google Maps and want to use that exact spot), skip geocoding for that
 * entry by adding "lat" and "lng" fields directly:
 *   { "date": "2026-08-20", "time": "10:30", "address": "My Custom Spot", "lat": 3.1516, "lng": 101.7040 }
 *
 * Requires internet access to nominatim.openstreetmap.org. This script was
 * written in a sandbox with no internet access, so the geocoding call itself
 * couldn't be tested end-to-end here - but it's the identical call already
 * working elsewhere in this app. Any entry that fails to geocode is skipped
 * with a clear warning rather than silently inserted with wrong coordinates.
 */
import fs from 'fs';
import { db, calculateDistanceMeters } from '../src/db/index.js';
import { trainPatientModel } from '../src/ml/trainer.js';

const [, , email, filePath] = process.argv;

if (!email || !filePath) {
  console.error('Usage: node scripts/seed-custom-locations.js <patient-email> <path-to-json-file>');
  process.exit(1);
}

const patient = db.prepare(`SELECT id, name FROM users WHERE email = ? AND role = 'patient'`).get(email);
if (!patient) {
  console.error(`No patient account found with email "${email}". Create one first via the app's "Add Patient" flow.`);
  process.exit(1);
}

const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patient.id);

let entries;
try {
  entries = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
} catch (err) {
  console.error(`Could not read/parse ${filePath}: ${err.message}`);
  console.error('Make sure it is plain valid JSON (no // comments - JSON does not support them).');
  process.exit(1);
}

if (!Array.isArray(entries) || entries.length === 0) {
  console.error('The JSON file must be a non-empty array of entries.');
  process.exit(1);
}

// Respectful use of the free public Nominatim service: a descriptive
// User-Agent is required by their usage policy, and requests are throttled
// to roughly one per second so this script doesn't get rate-limited/blocked.
// If it DOES get rate-limited anyway (HTTP 429 - e.g. other traffic on the
// same network/IP recently used up the shared quota), this retries with a
// longer backoff instead of immediately giving up on that address.
async function geocode(address, attempt = 1) {
  const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(address)}`, {
    headers: { 'User-Agent': 'SafeDementiaApp-TestSeedScript/1.0' }
  });

  if (res.status === 429 && attempt <= 3) {
    const retryAfterHeader = Number(res.headers.get('retry-after'));
    const backoffMs = retryAfterHeader > 0 ? retryAfterHeader * 1000 : 5000 * attempt; // server's own value if given, else 5s/10s/15s
    console.warn(`  Rate-limited (429) - waiting ${Math.round(backoffMs / 1000)}s before retry ${attempt}/3...`);
    await sleep(backoffMs);
    return geocode(address, attempt + 1);
  }

  if (!res.ok) throw new Error(`Nominatim returned HTTP ${res.status}`);
  const results = await res.json();
  if (!results.length) return null;
  return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const insert = db.prepare(
  `INSERT INTO location_history (patient_id, lat, lng, address, status, distance_from_home_m, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

async function run() {
  let inserted = 0;
  let skipped = 0;
  let lastPing = null;

  for (const entry of entries) {
    if (!entry.date || !entry.time || !entry.address) {
      console.warn(`Skipping entry missing date/time/address: ${JSON.stringify(entry)}`);
      skipped += 1;
      continue;
    }

    let coords;
    if (entry.lat != null && entry.lng != null) {
      coords = { lat: Number(entry.lat), lng: Number(entry.lng) };
    } else {
      // Every attempt below gets throttled (sleep), whether it succeeds,
      // fails, or finds nothing - a failed request still counts against
      // Nominatim's rate limit. Without throttling failures too, one early
      // failure removes all pacing for the rest of the file and cascades
      // into a run of 429s, which is exactly what was happening before.
      console.log(`Looking up "${entry.address}"...`);
      try {
        coords = await geocode(entry.address);
      } catch (err) {
        console.warn(`  Geocoding failed for "${entry.address}": ${err.message} - skipping this entry.`);
        skipped += 1;
        await sleep(1100);
        continue;
      }
      if (!coords) {
        console.warn(`  No results found for "${entry.address}" - skipping. Try a more specific address (add city/country).`);
        skipped += 1;
        await sleep(1100);
        continue;
      }
      await sleep(1100);
    }

    const ts = new Date(`${entry.date}T${entry.time}:00`);
    if (isNaN(ts.getTime())) {
      console.warn(`Invalid date/time in entry: ${JSON.stringify(entry)} - skipping.`);
      skipped += 1;
      continue;
    }

    let status = 'Unknown (no home address set for this patient yet)';
    let distance = null;
    if (profile?.home_lat != null) {
      distance = calculateDistanceMeters(coords.lat, coords.lng, profile.home_lat, profile.home_lng);
      status = distance > (profile.safe_radius_meters || 400) ? `Outside safe zone (${Math.round(distance)}m away)` : 'Inside safe zone';
    }

    insert.run(patient.id, coords.lat, coords.lng, entry.address, status, distance, ts.toISOString());
    inserted += 1;
    if (!lastPing || ts > lastPing.ts) lastPing = { ts, lat: coords.lat, lng: coords.lng, address: entry.address };
  }

  if (lastPing) {
    db.prepare(
      `UPDATE patient_profiles SET current_lat = ?, current_lng = ?, current_address = ?, location_updated_at = ? WHERE patient_id = ?`
    ).run(lastPing.lat, lastPing.lng, lastPing.address, lastPing.ts.toISOString(), patient.id);
  }

  console.log(`\nInserted ${inserted} manually-specified location(s) for ${patient.name}. Skipped ${skipped}.`);

  if (inserted > 0) {
    const trainResult = trainPatientModel(patient.id);
    console.log('Training result:', trainResult);
  }
}

run();
