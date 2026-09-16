#!/usr/bin/env node
/**
 * Measures real prediction accuracy over "time" using a walk-forward
 * backtest: at each checkpoint, train a model using ONLY the pings up to
 * that point, then check whether it correctly predicted the very next real
 * moves the patient made (which we already know, since it's their logged
 * history) - a place is a "hit" if it appeared in the model's top-3, same as
 * what the app actually shows a caregiver.
 *
 * Also compares personalized (regression-fit) weights against the shared
 * defaults at every checkpoint, using the identical trained stay-points and
 * transition matrix for both - so any difference in accuracy is coming
 * ONLY from the weights, not from a different model underneath.
 *
 * USAGE (run from the backend/ directory):
 *   node scripts/evaluate-accuracy.js <patient-email>
 *
 * Requires a patient with a reasonable amount of history - if you're testing
 * this, seed some first:
 *   node scripts/seed-test-data.js <patient-email> --days=40
 *
 * Outputs a text summary to the console AND a self-contained HTML report
 * (no internet/CDN needed - the chart is plain inline SVG) you can open in
 * any browser.
 */
import fs from 'fs';
import path from 'path';
import { db, calculateDistanceMeters } from '../src/db/index.js';
import { computeModelFromPings } from '../src/ml/trainer.js';
import { scoreCandidates } from '../src/ml/predictor.js';
import { DEFAULT_WEIGHTS } from '../src/ml/regression.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/evaluate-accuracy.js <patient-email>');
  process.exit(1);
}

const patient = db.prepare(`SELECT id, name FROM users WHERE email = ? AND role = 'patient'`).get(email);
if (!patient) {
  console.error(`No patient account found with email "${email}".`);
  process.exit(1);
}

const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patient.id);
const homeLocation = profile?.home_lat ? { lat: profile.home_lat, lng: profile.home_lng } : null;

const pings = db
  .prepare(`SELECT lat, lng, created_at FROM location_history WHERE patient_id = ? ORDER BY created_at ASC`)
  .all(patient.id);

const MIN_TRAIN = 8; // matches trainer.js's own floor - no point checkpointing below this
if (pings.length < MIN_TRAIN + 10) {
  console.error(`Only ${pings.length} pings on file - need quite a few more to run a meaningful backtest. Try seeding more history first.`);
  process.exit(1);
}

// Nearest stay-point to a given ping, using a already-trained model's
// stay-points as the reference set - this is how we figure out "which real
// place did they actually go to next", to grade the prediction against.
function nearestStayPoint(model, lat, lng) {
  let best = null, bestDist = Infinity;
  for (const sp of model.stayPoints) {
    const d = calculateDistanceMeters(lat, lng, sp.lat, sp.lng);
    if (d < bestDist) { bestDist = d; best = sp; }
  }
  return best;
}

// Checkpoints as fractions of the full ping history. At each one we train on
// everything up to that point, then test against the NEXT chunk (up to the
// next checkpoint) - genuinely held-out data the model never saw.
const CHECKPOINTS = [0.35, 0.50, 0.65, 0.80, 0.95];
const results = [];

for (const frac of CHECKPOINTS) {
  const trainEnd = Math.floor(pings.length * frac);
  const testEnd = Math.min(pings.length, Math.floor(pings.length * (frac + 0.15)));
  if (trainEnd < MIN_TRAIN || testEnd <= trainEnd + 1) continue;

  const trainingPings = pings.slice(0, trainEnd);
  const testPings = pings.slice(trainEnd, testEnd);

  const model = computeModelFromPings(trainingPings);
  if (!model.trained) {
    results.push({ frac, trainEnd, trained: false });
    continue;
  }

  let totalTransitions = 0;
  let hitsPersonalized1 = 0, hitsPersonalized3 = 0;
  let hitsDefault1 = 0, hitsDefault3 = 0;
  let candidatePoolSizes = [];
  let prevPing = trainingPings[trainingPings.length - 1];

  for (const ping of testPings) {
    const originSp = nearestStayPoint(model, prevPing.lat, prevPing.lng);
    const actualSp = nearestStayPoint(model, ping.lat, ping.lng);
    prevPing = ping;
    if (!originSp || !actualSp || originSp.id === actualSp.id) continue; // no real move happened

    totalTransitions++;
    const hour = new Date(ping.created_at).getHours();

    const personalizedRanked = scoreCandidates(model, { lat: originSp.lat, lng: originSp.lng }, homeLocation, hour, model.weights);
    const defaultRanked = scoreCandidates(model, { lat: originSp.lat, lng: originSp.lng }, homeLocation, hour, DEFAULT_WEIGHTS);
    candidatePoolSizes.push(personalizedRanked.length);

    if (personalizedRanked[0]?.sp.id === actualSp.id) hitsPersonalized1++;
    if (personalizedRanked.slice(0, 3).some((r) => r.sp.id === actualSp.id)) hitsPersonalized3++;
    if (defaultRanked[0]?.sp.id === actualSp.id) hitsDefault1++;
    if (defaultRanked.slice(0, 3).some((r) => r.sp.id === actualSp.id)) hitsDefault3++;
  }

  const avgPoolSize = candidatePoolSizes.length ? candidatePoolSizes.reduce((a, b) => a + b, 0) / candidatePoolSizes.length : 0;

  results.push({
    frac,
    trainEnd,
    trained: true,
    weightsFitted: model.weightsFitted,
    weights: model.weights,
    totalTransitions,
    avgPoolSize,
    accuracyPersonalized: totalTransitions ? hitsPersonalized1 / totalTransitions : null,
    accuracyDefault: totalTransitions ? hitsDefault1 / totalTransitions : null,
    accuracyPersonalized3: totalTransitions ? hitsPersonalized3 / totalTransitions : null,
    accuracyDefault3: totalTransitions ? hitsDefault3 / totalTransitions : null
  });
}

// --- Console summary ---
console.log(`\nWalk-forward backtest for ${patient.name} (${pings.length} total pings on file)\n`);
console.log('Training samples | Held-out moves | Avg candidates | Personalized top-1 | Default top-1 | Personalized top-3 | Default top-3 | Personalized?');
console.log('-----------------|----------------|----------------|---------------------|----------------|---------------------|----------------|---------------');
for (const r of results) {
  if (!r.trained) {
    console.log(`${String(r.trainEnd).padEnd(17)}| not enough data to train yet at this checkpoint`);
    continue;
  }
  if (r.totalTransitions === 0) {
    console.log(`${String(r.trainEnd).padEnd(17)}| no real moves in the held-out window - skipped`);
    continue;
  }
  console.log(
    `${String(r.trainEnd).padEnd(17)}| ${String(r.totalTransitions).padEnd(15)}| ${r.avgPoolSize.toFixed(1).padEnd(15)}| ` +
    `${(r.accuracyPersonalized * 100).toFixed(0).padEnd(4)}%               | ` +
    `${(r.accuracyDefault * 100).toFixed(0).padEnd(4)}%           | ` +
    `${(r.accuracyPersonalized3 * 100).toFixed(0).padEnd(4)}%               | ` +
    `${(r.accuracyDefault3 * 100).toFixed(0).padEnd(4)}%           | ${r.weightsFitted ? 'yes' : 'no (defaults)'}`
  );
}
console.log('\nNote: if "Avg candidates" is 3 or below, top-3 accuracy will look identical for both methods no matter');
console.log('what the weights are (there simply aren\'t more than 3 places to rank) - top-1 is the metric that');
console.log('actually shows whether personalization is changing anything in that situation.');

// --- The actual fitted weights at each checkpoint ---
console.log('\nFitted weights at each checkpoint (frequency / transition / distance / time / bias):\n');
for (const r of results) {
  if (!r.trained || r.totalTransitions === 0) continue;
  const w = r.weights;
  const label = r.weightsFitted ? 'personalized' : 'defaults (not enough transitions yet)';
  console.log(
    `${String(r.trainEnd).padEnd(6)} samples | ` +
    `freq ${(w.frequency * 100).toFixed(0).padStart(2)}%  ` +
    `trans ${(w.transition * 100).toFixed(0).padStart(2)}%  ` +
    `dist ${(w.distance * 100).toFixed(0).padStart(2)}%  ` +
    `time ${(w.time * 100).toFixed(0).padStart(2)}%  ` +
    `bias ${w.bias >= 0 ? '+' : ''}${w.bias.toFixed(3)}  (${label})`
  );
}

// --- HTML report with an inline SVG line chart (no CDN/internet needed) ---
const usable = results.filter((r) => r.trained && r.totalTransitions > 0);
function buildChart() {
  if (usable.length < 2) return '<p>Not enough checkpoints produced a testable result to draw a chart - try seeding more history.</p>';

  const W = 640, H = 320, padL = 50, padR = 20, padT = 20, padB = 40;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const xFor = (i) => padL + (i / (usable.length - 1)) * plotW;
  const yFor = (v) => padT + (1 - v) * plotH;

  const linePath = (key) => usable.map((r, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i)} ${yFor(r[key])}`).join(' ');
  const dots = (key, color) => usable.map((r, i) => `<circle cx="${xFor(i)}" cy="${yFor(r[key])}" r="4" fill="${color}" />`).join('');
  const xLabels = usable.map((r, i) => `<text x="${xFor(i)}" y="${H - padB + 18}" font-size="11" text-anchor="middle" fill="#94a3b8">${r.trainEnd}</text>`).join('');
  const yLabels = [0, 0.25, 0.5, 0.75, 1].map((v) => `<text x="${padL - 8}" y="${yFor(v) + 4}" font-size="11" text-anchor="end" fill="#94a3b8">${Math.round(v * 100)}%</text><line x1="${padL}" y1="${yFor(v)}" x2="${W - padR}" y2="${yFor(v)}" stroke="#334155" stroke-width="1" />`).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:${W}px;background:#0f172a;border-radius:12px">
      ${yLabels}
      <path d="${linePath('accuracyDefault')}" fill="none" stroke="#f59e0b" stroke-width="2.5" />
      ${dots('accuracyDefault', '#f59e0b')}
      <path d="${linePath('accuracyPersonalized')}" fill="none" stroke="#2dd4bf" stroke-width="2.5" />
      ${dots('accuracyPersonalized', '#2dd4bf')}
      ${xLabels}
      <text x="${W / 2}" y="${H - 5}" font-size="11" text-anchor="middle" fill="#64748b">Training samples used at each checkpoint</text>
    </svg>`;
}

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Prediction accuracy - ${patient.name}</title>
<style>
  body { background:#020617; color:#e2e8f0; font-family:-apple-system,Segoe UI,Roboto,sans-serif; padding:40px; max-width:760px; margin:0 auto; }
  h1 { font-size:20px; } p.sub { color:#94a3b8; font-size:13px; margin-top:-6px; }
  .legend { display:flex; gap:20px; margin:16px 0; font-size:13px; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .dot { width:10px; height:10px; border-radius:50%; display:inline-block; }
  table { width:100%; border-collapse:collapse; margin-top:24px; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid #1e293b; }
  th { color:#94a3b8; font-weight:600; }
  .note { color:#64748b; font-size:12px; margin-top:14px; line-height:1.5; }
</style></head>
<body>
  <h1>Prediction accuracy over time - ${patient.name}</h1>
  <p class="sub">Walk-forward backtest across ${pings.length} logged GPS pings. Chart shows top-1 accuracy - the real next place they went was the model's #1 prediction.</p>
  <div class="legend">
    <span><span class="dot" style="background:#2dd4bf"></span> Personalized (regression-fit) weights</span>
    <span><span class="dot" style="background:#f59e0b"></span> Shared default weights</span>
  </div>
  ${buildChart()}
  <table>
    <tr><th>Training samples</th><th>Held-out moves</th><th>Avg candidates</th><th>Personalized top-1</th><th>Default top-1</th><th>Personalized top-3</th><th>Default top-3</th></tr>
    ${results.map((r) => r.trained && r.totalTransitions > 0
      ? `<tr><td>${r.trainEnd}</td><td>${r.totalTransitions}</td><td>${r.avgPoolSize.toFixed(1)}</td><td>${Math.round(r.accuracyPersonalized * 100)}%</td><td>${Math.round(r.accuracyDefault * 100)}%</td><td>${Math.round(r.accuracyPersonalized3 * 100)}%</td><td>${Math.round(r.accuracyDefault3 * 100)}%</td></tr>`
      : `<tr><td>${r.trainEnd}</td><td colspan="6">${!r.trained ? 'Not enough data to train yet' : 'No real moves in this held-out window'}</td></tr>`
    ).join('')}
  </table>
    <p class="note">If "Avg candidates" is 3 or below, top-3 accuracy will look identical for both methods regardless of
  the weights, since there simply aren't more than 3 places to rank - top-1 is the metric that actually shows
  whether personalization is changing anything when a patient has a small number of regular places.</p>

  <h2 style="font-size:15px;margin-top:32px">Fitted weights at each checkpoint</h2>
  <table>
    <tr><th>Training samples</th><th>Frequency</th><th>Transition</th><th>Distance</th><th>Time of day</th><th>Bias</th><th>Status</th></tr>
    ${results.filter((r) => r.trained && r.totalTransitions > 0).map((r) => `
      <tr>
        <td>${r.trainEnd}</td>
        <td>${Math.round(r.weights.frequency * 100)}%</td>
        <td>${Math.round(r.weights.transition * 100)}%</td>
        <td>${Math.round(r.weights.distance * 100)}%</td>
        <td>${Math.round(r.weights.time * 100)}%</td>
        <td>${r.weights.bias >= 0 ? '+' : ''}${r.weights.bias.toFixed(3)}</td>
        <td>${r.weightsFitted ? 'Personalized' : 'Defaults'}</td>
      </tr>`).join('')}
  </table>
</body></html>`;

const outPath = path.join(process.cwd(), `accuracy-report-${patient.id}.html`);
fs.writeFileSync(outPath, html);
console.log(`\nHTML report saved to: ${outPath}\nOpen it in any browser to see the chart.`);
