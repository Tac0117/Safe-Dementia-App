import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireLinkedPatient } from '../auth/middleware.js';
import { predictMissingLocation } from '../ml/predictor.js';
import { getTrainedModel } from '../ml/trainer.js';

const router = Router();

router.get('/:patientId/ml/status', requireAuth, requireLinkedPatient, (req, res) => {
  const patientId = Number(req.params.patientId);
  const sampleCount = db.prepare(`SELECT COUNT(*) as n FROM location_history WHERE patient_id = ?`).get(patientId).n;
  const model = getTrainedModel(patientId);
  res.json({
    sampleCount,
    isTrained: !!model,
    stayPointCount: model?.stayPoints?.length || 0,
    trainedOnSamples: model?.trainedOnSamples || 0,
    trainedAt: model?.trainedAt || null,
    weightsPersonalized: !!model?.weightsFitted,
    weightsTrainingExamples: model?.weightsTrainingExamples || 0,
    weights: model?.weights || null
  });
});

router.post('/:patientId/ml/predict', requireAuth, requireLinkedPatient, async (req, res) => {
  const patientId = Number(req.params.patientId);
  const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);
  if (!profile?.current_lat) return res.status(400).json({ error: 'No current location on file for this patient yet' });

  const lastLocation = { lat: profile.current_lat, lng: profile.current_lng };
  const homeLocation = profile.home_lat ? { lat: profile.home_lat, lng: profile.home_lng } : null;

  const result = await predictMissingLocation(patientId, lastLocation, homeLocation);
  res.json(result);
});

export default router;
