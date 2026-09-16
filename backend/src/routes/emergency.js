import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireLinkedPatient, requireRole } from '../auth/middleware.js';

const router = Router();

// Patient-initiated "I Feel Lost" button. This is a REAL emergency event —
// it uses the patient's actual last-known location from the DB (whatever the
// device most recently reported), not a hardcoded/teleported coordinate.
router.post('/:patientId/emergency/trigger', requireAuth, requireLinkedPatient, (req, res) => {
  const patientId = Number(req.params.patientId);
  const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);
  const timestamp = new Date().toISOString();

  db.prepare(
    `INSERT INTO emergency_events (patient_id, trigger_type, lat, lng, address, distance_from_home_m)
     VALUES (?, 'manual_button', ?, ?, ?, NULL)`
  ).run(patientId, profile?.current_lat ?? null, profile?.current_lng ?? null, profile?.current_address ?? null);

  db.prepare(`UPDATE patient_profiles SET is_missing = 1, missing_since = COALESCE(missing_since, ?) WHERE patient_id = ?`)
    .run(timestamp, patientId);

  res.json({
    success: true,
    message: 'Emergency alert sent to your caregiver.',
    emergencyPhone: profile?.emergency_phone || null
  });
});

router.get('/:patientId/emergency/events', requireAuth, requireLinkedPatient, (req, res) => {
  const rows = db
    .prepare(`SELECT * FROM emergency_events WHERE patient_id = ? ORDER BY created_at DESC LIMIT 25`)
    .all(Number(req.params.patientId));
  res.json(rows);
});

// Caregiver acknowledges / resolves an active emergency (e.g. patient was found).
router.post('/:patientId/emergency/:eventId/resolve', requireAuth, requireLinkedPatient, requireRole('caregiver'), (req, res) => {
  const { eventId } = req.params;
  const patientId = Number(req.params.patientId);
  const timestamp = new Date().toISOString();

  db.prepare(`UPDATE emergency_events SET status = 'resolved', resolved_at = ?, resolved_by = ? WHERE id = ? AND patient_id = ?`)
    .run(timestamp, req.user.id, eventId, patientId);

  const stillActive = db
    .prepare(`SELECT COUNT(*) as n FROM emergency_events WHERE patient_id = ? AND status = 'active'`)
    .get(patientId).n;

  if (stillActive === 0) {
    db.prepare(`UPDATE patient_profiles SET is_missing = 0, missing_since = NULL WHERE patient_id = ?`).run(patientId);
  }

  res.json({ success: true });
});

export default router;
