#!/usr/bin/env node
/**
 * Seeds realistic-looking GPS history for an existing patient, so you can
 * test the prediction model without waiting days for real data to accumulate.
 *
 * WHY THIS SCRIPT EXISTS (rather than just calling the live /location API
 * repeatedly): every ping sent through the real API gets timestamped with
 * the current real time. Firing 100 requests in a row to fake "a week of
 * history" would give you a week's worth of PLACES but all bunched into the
 * same few real minutes - which breaks the time-of-day part of the model,
 * since every visit would look like it happened at the same hour. This
 * script writes directly to the database with realistic, spread-out,
 * backdated timestamps instead.
 *
 * USAGE (run from the backend/ directory):
 *   node scripts/seed-test-data.js patient@example.com
 *   node scripts/seed-test-data.js patient@example.com --days=14
 *
 * The patient must already exist (create them normally via the app's
 * "Add Patient" flow first) and must already have a home/safe-zone address
 * set (via Edit Profile in the app) - the script builds realistic "regular
 * places" as offsets from that home location.
 */
import { db, calculateDistanceMeters } from '../src/db/index.js';
import { trainPatientModel } from '../src/ml/trainer.js';

const args = process.argv.slice(2);
const email = args.find((a) => !a.startsWith('--'));
const daysArg = args.find((a) => a.startsWith('--days='));
const DAYS = daysArg ? Number(daysArg.split('=')[1]) : 10;

if (!email) {
  console.error('Usage: node scripts/seed-test-data.js <patient-email> [--days=10]');
  process.exit(1);
}

const patient = db.prepare(`SELECT id, name FROM users WHERE email = ? AND role = 'patient'`).get(email);
if (!patient) {
  console.error(`No patient account found with email "${email}". Create one first via the app's "Add Patient" flow.`);
  process.exit(1);
}

const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patient.id);
if (!profile?.home_lat) {
  console.error(`${patient.name} doesn't have a home address / safe zone set yet. Set one first via "Edit Profile" in the app, then re-run this script.`);
  process.exit(1);
}

const home = { lat: profile.home_lat, lng: profile.home_lng };

// Converts a small (meters-east, meters-north) offset into a lat/lng delta.
function offset(lat, lng, metersEast, metersNorth) {
  const dLat = metersNorth / 111320;
  const dLng = metersEast / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}
function jitter(meters = 15) {
  return (Math.random() - 0.5) * 2 * meters;
}

// A plausible weekly routine: home mornings/nights, a park most mornings,
// a cafe some afternoons, a clinic once a week. Edit this to model a
// different patient's routine if you want to test other patterns.
const PARK = offset(home.lat, home.lng, 420, 260);
const CAFE = offset(home.lat, home.lng, -180, 90);
const CLINIC = offset(home.lat, home.lng, 650, -400);

const ROUTINE = [
  { place: home, address: profile.home_address || 'Home', hour: 7, minute: 0, probability: 0.95 },
  { place: PARK, address: 'Nearby Park', hour: 10, minute: 30, probability: 0.7 },
  { place: PARK, address: 'Nearby Park', hour: 11, minute: 0, probability: 0.5 },
  { place: home, address: profile.home_address || 'Home', hour: 13, minute: 0, probability: 0.9 },
  { place: CAFE, address: 'Corner Cafe', hour: 15, minute: 30, probability: 0.4 },
  { place: CLINIC, address: 'Local Clinic', hour: 10, minute: 0, probability: 1 / 7 },
  { place: home, address: profile.home_address || 'Home', hour: 20, minute: 0, probability: 0.95 }
];

const insert = db.prepare(
  `INSERT INTO location_history (patient_id, lat, lng, address, status, distance_from_home_m, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

let inserted = 0;
let lastPing = null;

db.exec('BEGIN');
try {
  for (let daysAgo = DAYS; daysAgo >= 0; daysAgo--) {
    for (const step of ROUTINE) {
      if (Math.random() > step.probability) continue; // skip this visit some days, like real life

      const lat = step.place.lat + jitter() / 111320;
      const lng = step.place.lng + jitter() / (111320 * Math.cos((step.place.lat * Math.PI) / 180));

      const ts = new Date();
      ts.setDate(ts.getDate() - daysAgo);
      ts.setHours(step.hour, step.minute + Math.round(jitter(10)), 0, 0);

      const distance = calculateDistanceMeters(lat, lng, home.lat, home.lng);
      const status = distance > (profile.safe_radius_meters || 400) ? `Outside safe zone (${Math.round(distance)}m away)` : 'Inside safe zone';

      insert.run(patient.id, lat, lng, step.address, status, distance, ts.toISOString());
      inserted += 1;
      if (!lastPing || ts > lastPing.ts) lastPing = { ts, lat, lng, address: step.address };
    }
  }

  if (lastPing) {
    db.prepare(
      `UPDATE patient_profiles SET current_lat = ?, current_lng = ?, current_address = ?, location_updated_at = ? WHERE patient_id = ?`
    ).run(lastPing.lat, lastPing.lng, lastPing.address, lastPing.ts.toISOString(), patient.id);
  }

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('Seeding failed:', err);
  process.exit(1);
}

console.log(`Inserted ${inserted} backdated location pings for ${patient.name} across ${DAYS} days.`);

const trainResult = trainPatientModel(patient.id);
console.log('Training result:', trainResult);
console.log(`\nDone. Log in as the caregiver and click "Run AI Location Prediction" for ${patient.name} to see it in action.`);
