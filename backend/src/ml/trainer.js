import { db, calculateDistanceMeters } from '../db/index.js';
import { fitPersonalizedWeights, DEFAULT_WEIGHTS } from './regression.js';

// --- Config ---
const MIN_SAMPLES_TO_TRAIN = 8;          // don't even attempt training below this
const RETRAIN_EVERY_N_NEW_SAMPLES = 5;   // retrain cadence as new pings arrive
const CLUSTER_RADIUS_METERS = 150;       // pings within this radius are "the same place"
const MIN_VISITS_PER_STAYPOINT = 2;      // ignore one-off pings (noise, transit)

/**
 * Stay-point clustering: a simple, real, greedy spatial clustering over the
 * patient's own location_history. Each ping either joins the nearest existing
 * cluster (if within CLUSTER_RADIUS_METERS) or seeds a new one. This is the
 * same family of method GeoLife-style stay-point extraction uses (distance +
 * revisit thresholding), just without the time-duration axis, kept simple on
 * purpose so it's auditable in a few lines of code.
 */
function clusterStayPoints(pings) {
  const clusters = []; // { lat, lng, count, hours: [] }

  for (const p of pings) {
    let best = null;
    let bestDist = Infinity;
    for (const c of clusters) {
      const d = calculateDistanceMeters(p.lat, p.lng, c.lat, c.lng);
      if (d < CLUSTER_RADIUS_METERS && d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    if (best) {
      // Running average keeps the cluster centered as more points join it.
      best.lat = (best.lat * best.count + p.lat) / (best.count + 1);
      best.lng = (best.lng * best.count + p.lng) / (best.count + 1);
      best.count += 1;
      best.hours.push(new Date(p.created_at).getHours());
      best.pings.push(p);
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, count: 1, hours: [new Date(p.created_at).getHours()], pings: [p] });
    }
  }

  return clusters.filter((c) => c.count >= MIN_VISITS_PER_STAYPOINT);
}

function assignVisitSequence(pings, clusters) {
  // Map each ping, in chronological order, to the cluster it belongs to,
  // collapsing consecutive pings at the same place into a single "visit".
  // Also tracks the hour-of-day each visit happened, so regression.js can
  // build time-aware training examples from the same sequence.
  const chrono = [...pings].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const sequence = [];
  const hours = [];
  for (const p of chrono) {
    let nearestIdx = -1;
    let nearestDist = Infinity;
    clusters.forEach((c, idx) => {
      const d = calculateDistanceMeters(p.lat, p.lng, c.lat, c.lng);
      if (d < nearestDist) {
        nearestDist = d;
        nearestIdx = idx;
      }
    });
    if (nearestIdx === -1 || nearestDist > CLUSTER_RADIUS_METERS) continue;
    if (sequence[sequence.length - 1] !== nearestIdx) {
      sequence.push(nearestIdx);
      hours.push(new Date(p.created_at).getHours());
    }
  }
  return { sequence, hours };
}

/**
 * The pure "given these pings, compute a model" pipeline - no database
 * involved. trainPatientModel (below) is a thin wrapper that reads pings
 * from the DB and writes the result back; this function is what actually
 * does the work, and is reused as-is by the accuracy backtest script so the
 * backtest is guaranteed to run the exact same logic production uses, not a
 * reimplementation that could quietly drift out of sync.
 */
export function computeModelFromPings(pings) {
  if (pings.length < MIN_SAMPLES_TO_TRAIN) {
    return { trained: false, reason: 'insufficient_data', samples: pings.length, required: MIN_SAMPLES_TO_TRAIN };
  }

  const clusters = clusterStayPoints(pings);
  if (clusters.length === 0) {
    return { trained: false, reason: 'no_stable_locations', samples: pings.length };
  }

  const totalVisitPings = clusters.reduce((sum, c) => sum + c.count, 0);
  const stayPoints = clusters.map((c, idx) => {
    const hourCounts = new Array(24).fill(0);
    c.hours.forEach((h) => (hourCounts[h] += 1));
    const maxCount = Math.max(...hourCounts);
    const typicalHours = hourCounts
      .map((cnt, h) => ({ h, cnt }))
      .filter((x) => x.cnt >= maxCount * 0.5 && x.cnt > 0)
      .map((x) => x.h);

    return {
      id: `sp_${idx}`,
      lat: c.lat,
      lng: c.lng,
      visitCount: c.count,
      historicalFrequency: c.count / totalVisitPings,
      typicalHours
    };
  });

  const { sequence, hours } = assignVisitSequence(pings, clusters);
  const transitionCounts = {};
  for (let i = 0; i < sequence.length - 1; i++) {
    const from = `sp_${sequence[i]}`;
    const to = `sp_${sequence[i + 1]}`;
    transitionCounts[from] = transitionCounts[from] || {};
    transitionCounts[from][to] = (transitionCounts[from][to] || 0) + 1;
  }
  // Normalize counts into probabilities per origin.
  const transitionMatrix = {};
  for (const from of Object.keys(transitionCounts)) {
    const total = Object.values(transitionCounts[from]).reduce((a, b) => a + b, 0);
    transitionMatrix[from] = {};
    for (const to of Object.keys(transitionCounts[from])) {
      transitionMatrix[from][to] = transitionCounts[from][to] / total;
    }
  }

  // Fit this patient's own weights from their real transition history (see
  // regression.js) - falls back to DEFAULT_WEIGHTS honestly if there isn't
  // enough real transition data yet to trust a personalized fit.
  const weightResult = fitPersonalizedWeights(stayPoints, sequence, hours, transitionMatrix);

  return {
    trained: true,
    samples: pings.length,
    stayPointCount: stayPoints.length,
    stayPoints,
    transitionMatrix,
    weights: weightResult.weights,
    weightsFitted: weightResult.fitted,
    weightsTrainingExamples: weightResult.trainingExamples
  };
}

/**
 * Trains (fits) a personalized location model from a patient's actual GPS
 * history: real stay-points, real transition frequencies between them (counted
 * from the patient's chronological movement, not hand-picked), and a real
 * time-of-day histogram per stay-point. This is genuine parameter estimation
 * from data — the honest alternative to hardcoded "park is +0.0032 lat" stubs.
 */
export function trainPatientModel(patientId) {
  const pings = db
    .prepare(`SELECT lat, lng, created_at FROM location_history WHERE patient_id = ? ORDER BY created_at ASC`)
    .all(patientId);

  const result = computeModelFromPings(pings);
  if (!result.trained) return result;

  const params = {
    stayPoints: result.stayPoints,
    transitionMatrix: result.transitionMatrix,
    weights: result.weights,
    weightsFitted: result.weightsFitted,
    weightsTrainingExamples: result.weightsTrainingExamples
  };
  const trainedAt = new Date().toISOString();

  db.prepare(
    `INSERT INTO location_models (patient_id, params, trained_on_samples, trained_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(patient_id) DO UPDATE SET params = excluded.params, trained_on_samples = excluded.trained_on_samples, trained_at = excluded.trained_at`
  ).run(patientId, JSON.stringify(params), pings.length, trainedAt);

  return { trained: true, samples: pings.length, stayPointCount: result.stayPointCount, trainedAt, weightsFitted: result.weightsFitted };
}

/**
 * Called after every location ping. Cheap no-op unless enough new data has
 * accumulated since the last training run — keeps retraining from happening
 * on every single request.
 */
export async function maybeRetrain(patientId) {
  const existing = db.prepare(`SELECT trained_on_samples FROM location_models WHERE patient_id = ?`).get(patientId);
  const currentCount = db.prepare(`SELECT COUNT(*) as n FROM location_history WHERE patient_id = ?`).get(patientId).n;

  const lastTrainedOn = existing?.trained_on_samples || 0;
  if (currentCount >= MIN_SAMPLES_TO_TRAIN && currentCount - lastTrainedOn >= RETRAIN_EVERY_N_NEW_SAMPLES) {
    trainPatientModel(patientId);
  }
}

export function getTrainedModel(patientId) {
  const row = db.prepare(`SELECT * FROM location_models WHERE patient_id = ?`).get(patientId);
  if (!row) return null;
  return { ...JSON.parse(row.params), trainedOnSamples: row.trained_on_samples, trainedAt: row.trained_at };
}
