import { calculateDistanceMeters } from '../db/index.js';
import { getTrainedModel, trainPatientModel } from './trainer.js';
import { nameForStayPoint } from './nearbyPlaces.js';
import { DEFAULT_WEIGHTS } from './regression.js';

/**
 * The pure scoring step: given a trained model, where they were last seen,
 * home (if any), and the hour of day, rank every candidate stay-point.
 * Takes an explicit weights argument (rather than always reading
 * model.weights) so the accuracy backtest script can score the SAME model
 * with personalized weights and with the shared defaults side by side, to
 * measure whether personalization is actually earning its keep - without
 * this being a separate reimplementation that could drift from what
 * production actually does.
 */
export function scoreCandidates(model, originLocation, homeLocation, hour, weights) {
  const homeDist = homeLocation
    ? model.stayPoints.map((sp) => calculateDistanceMeters(sp.lat, sp.lng, homeLocation.lat, homeLocation.lng))
    : [];
  const candidates = model.stayPoints.filter((sp, idx) => !homeLocation || homeDist[idx] > 30);

  let nearestOrigin = null;
  let minDistance = Infinity;
  for (const sp of model.stayPoints) {
    const d = calculateDistanceMeters(originLocation.lat, originLocation.lng, sp.lat, sp.lng);
    if (d < minDistance) {
      minDistance = d;
      nearestOrigin = sp;
    }
  }

  const scored = candidates.map((sp) => {
    const distMeters = calculateDistanceMeters(originLocation.lat, originLocation.lng, sp.lat, sp.lng);
    const distKm = distMeters / 1000;
    const distScore = Math.exp(-distKm / 1.2);

    const transitionProb = nearestOrigin && model.transitionMatrix[nearestOrigin.id]
      ? (model.transitionMatrix[nearestOrigin.id][sp.id] || 0)
      : 0;

    const timeIndicator = sp.typicalHours.includes(hour) ? 1 : 0;

    const rawScore =
      sp.historicalFrequency * weights.frequency +
      transitionProb * weights.transition +
      distScore * weights.distance +
      timeIndicator * weights.time +
      weights.bias;
    const finalScore = Math.min(0.97, Math.max(0.03, rawScore));

    return { sp, distMeters, finalScore, timeIndicator };
  });

  scored.sort((a, b) => b.finalScore - a.finalScore);
  return scored;
}

/**
 * Predicts likely destinations using ONLY the patient's OWN trained model
 * (see trainer.js) - real stay-points learned from their actual logged GPS
 * history, scored by visit frequency, learned transition probability, and
 * time-of-day pattern match. If there isn't enough history yet to have
 * trained a model, this says so explicitly rather than guessing.
 */
export async function predictMissingLocation(patientId, lastLocation, homeLocation) {
  // Make sure we're using the freshest model possible before predicting.
  trainPatientModel(patientId);
  const model = getTrainedModel(patientId);

  if (!model) {
    return {
      predictionTimestamp: new Date().toISOString(),
      lastKnownLocation: lastLocation,
      trained: false,
      message: 'Not enough location history yet to make a personalized prediction. The model trains automatically as GPS pings accumulate (needs at least 8 logged locations across at least 2 distinct places).',
      topPredictions: []
    };
  }

  const hour = new Date().getHours();
  const weights = model.weights || DEFAULT_WEIGHTS;
  const scored = scoreCandidates(model, lastLocation, homeLocation, hour, weights);
  const top = scored.slice(0, 3);

  // Enrich the top learned predictions with a real place name from OpenStreetMap
  // where one can be found nearby (e.g. "Riverside Park" instead of "Learned
  // location #2"). Falls back to a generic label if lookup fails or nothing
  // named is nearby - never guesses a name.
  const enriched = await Promise.all(top.map(async ({ sp, distMeters, finalScore, timeIndicator }) => {
    const place = await nameForStayPoint(sp.lat, sp.lng).catch(() => null);
    return {
      id: sp.id,
      lat: sp.lat,
      lng: sp.lng,
      visitCount: sp.visitCount,
      distanceMeters: Math.round(distMeters),
      confidencePercent: Math.round(finalScore * 100),
      placeName: place?.name || null,
      placeCategory: place?.categoryLabel || null,
      reasoning: `Learned from ${sp.visitCount} past visits to this location; ${
        timeIndicator ? 'matches their usual time-of-day pattern here' : 'outside their usual hours here'
      }.`
    };
  }));

  return {
    predictionTimestamp: new Date().toISOString(),
    lastKnownLocation: lastLocation,
    trained: true,
    trainedOnSamples: model.trainedOnSamples,
    trainedAt: model.trainedAt,
    weightsPersonalized: !!model.weightsFitted,
    weightsTrainingExamples: model.weightsTrainingExamples || 0,
    weights: model.weights || DEFAULT_WEIGHTS,
    topPredictions: enriched
  };
}
