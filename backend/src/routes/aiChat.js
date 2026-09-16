import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireLinkedPatient } from '../auth/middleware.js';
import { generatePatientChatResponse } from '../aiChat.js';

const router = Router();

router.post('/:patientId/chat', requireAuth, requireLinkedPatient, async (req, res) => {
  const patientId = Number(req.params.patientId);
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'Message required' });

  const patientUser = db.prepare(`SELECT name FROM users WHERE id = ?`).get(patientId);
  const profile = db.prepare(`SELECT * FROM patient_profiles WHERE patient_id = ?`).get(patientId);
  const caregiver = db
    .prepare(
      `SELECT u.name FROM caregiver_patient_links l JOIN users u ON u.id = l.caregiver_id WHERE l.patient_id = ?`
    )
    .get(patientId);

  const history = db
    .prepare(`SELECT sender, text FROM chat_history WHERE patient_id = ? ORDER BY created_at ASC LIMIT 20`)
    .all(patientId);

  const patientProfile = {
    name: patientUser?.name,
    age: profile?.age,
    emergencyPhone: profile?.emergency_phone,
    isMissing: !!profile?.is_missing,
    currentLocation: { lat: profile?.current_lat, lng: profile?.current_lng, address: profile?.current_address },
    safeZone: { center: { lat: profile?.home_lat, lng: profile?.home_lng }, radiusMeters: profile?.safe_radius_meters }
  };

  const botReply = await generatePatientChatResponse(message, history, patientProfile, caregiver?.name);

  db.prepare(`INSERT INTO chat_history (patient_id, sender, text) VALUES (?, 'user', ?)`).run(patientId, message);
  db.prepare(`INSERT INTO chat_history (patient_id, sender, text) VALUES (?, 'bot', ?)`).run(patientId, botReply.text);

  res.json({ reply: botReply.text, fallback: botReply.fallback });
});

router.get('/:patientId/chat', requireAuth, requireLinkedPatient, (req, res) => {
  const rows = db
    .prepare(`SELECT sender, text, created_at as timestamp FROM chat_history WHERE patient_id = ? ORDER BY created_at ASC`)
    .all(Number(req.params.patientId));
  res.json(rows);
});

export default router;
