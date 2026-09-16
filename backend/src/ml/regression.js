import { calculateDistanceMeters } from '../db/index.js';

// --- Config ---
// Below this many REAL transition examples (i.e. actual "they went from A to
// B" events in their history), we don't trust a fitted regression yet - too
// few examples and the fit would just be chasing noise. Until then, every
// patient uses these same sane defaults, same as the app always has.
const MIN_TRANSITIONS_FOR_REGRESSION = 15;
const LEARNING_RATE = 0.1;
const ITERATIONS = 500;
// Pulls the fit back toward the defaults, proportional to how far it's
// strayed. Keeps a patient with "enough" data (15-30 examples) from
// producing wild, overfit weights, while patients with lots of history
// (hundreds of examples) can move further from the defaults since the
// gradient signal increasingly dominates the small L2 pull.
const L2_LAMBDA = 0.05;

// The starting point AND the regularization anchor. "time" here is a clean
// linear feature (1 if this is one of the candidate's usual hours, else 0)
// rather than the old multiplicative 1.35x/0.8x bonus - multiplicative
// factors don't fit into a linear regression cleanly, so this is folded into
// the same additive scheme as the other three signals.
export const DEFAULT_WEIGHTS = { frequency: 0.30, transition: 0.35, distance: 0.20, time: 0.15, bias: 0 };

/**
 * Turns a patient's real chronological stay-point visits into labeled
 * training examples for regression: for every real transition (origin -> the
 * place they actually went next), every OTHER known place at that moment is
 * a negative example ("they could have gone here, but didn't"), and the
 * place they actually went is the one positive example. This is genuine
 * supervised learning from the patient's own logged behavior - not
 * simulated or hand-picked data.
 */
function buildTrainingExamples(clusters, sequence, sequenceHours, transitionMatrix) {
  const examples = [];

  for (let i = 0; i < sequence.length - 1; i++) {
    const originIdx = sequence[i];
    const actualNextIdx = sequence[i + 1];
    const hour = sequenceHours[i + 1];
    const originId = `sp_${originIdx}`;
    const origin = clusters[originIdx];

    for (let j = 0; j < clusters.length; j++) {
      if (j === originIdx) continue; // "stayed put" isn't a candidate destination
      const candidate = clusters[j];
      const candidateId = `sp_${j}`;

      const freq = candidate.historicalFrequency;
      const transProb = (transitionMatrix[originId] && transitionMatrix[originId][candidateId]) || 0;
      const distKm = calculateDistanceMeters(origin.lat, origin.lng, candidate.lat, candidate.lng) / 1000;
      const distScore = Math.exp(-distKm / 1.2);
      const timeIndicator = candidate.typicalHours.includes(hour) ? 1 : 0;

      examples.push({ freq, transProb, distScore, timeIndicator, label: j === actualNextIdx ? 1 : 0 });
    }
  }

  return examples;
}

/**
 * Fits personalized weights via batch gradient descent, minimizing squared
 * error between the linear score and the real 0/1 outcome (a "linear
 * probability model" - literal linear regression applied to binary labels).
 * This is a legitimate, simple, and honest choice for a RANKING use case
 * like this one, where only the relative ordering of candidates matters, not
 * a calibrated probability. If calibrated probabilities ever matter more
 * than ranking, logistic regression (same linear combination, passed through
 * a sigmoid, fit with log-loss instead of squared error) would be the more
 * textbook-correct upgrade - the feature set and training examples here
 * would carry over unchanged.
 */
function fitWeights(examples) {
  const positiveCount = examples.filter((e) => e.label === 1).length;
  if (positiveCount < MIN_TRANSITIONS_FOR_REGRESSION) {
    return { weights: DEFAULT_WEIGHTS, fitted: false, trainingExamples: positiveCount };
  }

  let w = { ...DEFAULT_WEIGHTS };
  const n = examples.length;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    let gFreq = 0, gTrans = 0, gDist = 0, gTime = 0, gBias = 0;

    for (const ex of examples) {
      const predicted = w.frequency * ex.freq + w.transition * ex.transProb + w.distance * ex.distScore + w.time * ex.timeIndicator + w.bias;
      const error = predicted - ex.label; // d(squared error)/d(predicted)
      gFreq += error * ex.freq;
      gTrans += error * ex.transProb;
      gDist += error * ex.distScore;
      gTime += error * ex.timeIndicator;
      gBias += error;
    }

    w.frequency -= LEARNING_RATE * (gFreq / n + L2_LAMBDA * (w.frequency - DEFAULT_WEIGHTS.frequency));
    w.transition -= LEARNING_RATE * (gTrans / n + L2_LAMBDA * (w.transition - DEFAULT_WEIGHTS.transition));
    w.distance -= LEARNING_RATE * (gDist / n + L2_LAMBDA * (w.distance - DEFAULT_WEIGHTS.distance));
    w.time -= LEARNING_RATE * (gTime / n + L2_LAMBDA * (w.time - DEFAULT_WEIGHTS.time));
    w.bias -= LEARNING_RATE * (gBias / n + L2_LAMBDA * (w.bias - DEFAULT_WEIGHTS.bias));
  }

  // Keep each signal weight meaningfully non-negative (a negative weight
  // would mean "the more they've actually gone here, the LESS likely they
  // are to go" - not a sane reading of these particular signals), then
  // renormalize the four signal weights back to summing to 1, so the result
  // stays interpretable as "this patient's predictions rely X% on frequency,
  // Y% on transitions..." exactly like the original fixed weights were.
  const floor = 0.02;
  const freq = Math.max(w.frequency, floor);
  const trans = Math.max(w.transition, floor);
  const dist = Math.max(w.distance, floor);
  const time = Math.max(w.time, floor);
  const total = freq + trans + dist + time;

  const weights = {
    frequency: freq / total,
    transition: trans / total,
    distance: dist / total,
    time: time / total,
    bias: Math.max(-0.15, Math.min(0.15, w.bias)) // small offset only - never allowed to dominate the score
  };

  return { weights, fitted: true, trainingExamples: positiveCount };
}

/**
 * Full pipeline: build training examples from this patient's real visit
 * sequence, then fit (or fall back to defaults). Returns both the weights to
 * use and whether they're genuinely personalized yet, so the UI can be
 * honest about which is happening.
 */
export function fitPersonalizedWeights(clusters, sequence, sequenceHours, transitionMatrix) {
  if (sequence.length < 2) return { weights: DEFAULT_WEIGHTS, fitted: false, trainingExamples: 0 };
  const examples = buildTrainingExamples(clusters, sequence, sequenceHours, transitionMatrix);
  return fitWeights(examples);
}
