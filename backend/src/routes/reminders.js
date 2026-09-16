import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireLinkedPatient } from '../auth/middleware.js';

const router = Router();

router.get('/:patientId/reminders', requireAuth, requireLinkedPatient, (req, res) => {
  const patientId = Number(req.params.patientId);
  const rows = db
    .prepare(
      `SELECT id, created_by_role, text, reminder_time, is_done, created_at
       FROM reminders WHERE patient_id = ? ORDER BY is_done ASC, reminder_time ASC, created_at DESC`
    )
    .all(patientId);
  res.json(rows);
});

router.post('/:patientId/reminders', requireAuth, requireLinkedPatient, (req, res) => {
  const patientId = Number(req.params.patientId);
  const { text, reminderTime } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Reminder text is required' });

  const info = db
    .prepare(
      `INSERT INTO reminders (patient_id, created_by_role, text, reminder_time) VALUES (?, ?, ?, ?)`
    )
    .run(patientId, req.user.role, text.trim(), reminderTime || null);

  const reminder = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(info.lastInsertRowid);
  res.json({ success: true, reminder });
});

// Either party can check a reminder off (or back on) - that's the core
// "notebook" interaction, same as physically crossing something off a list.
router.post('/:patientId/reminders/:reminderId/toggle', requireAuth, requireLinkedPatient, (req, res) => {
  const { reminderId } = req.params;
  const patientId = Number(req.params.patientId);

  const reminder = db.prepare(`SELECT * FROM reminders WHERE id = ? AND patient_id = ?`).get(reminderId, patientId);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found' });

  db.prepare(`UPDATE reminders SET is_done = ? WHERE id = ?`).run(reminder.is_done ? 0 : 1, reminderId);
  res.json({ success: true });
});

// Either party can edit a reminder's text/time (e.g. fixing a typo or
// correcting a medicine time), same shared-notebook model as toggling.
router.put('/:patientId/reminders/:reminderId', requireAuth, requireLinkedPatient, (req, res) => {
  const { reminderId } = req.params;
  const patientId = Number(req.params.patientId);
  const { text, reminderTime } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Reminder text is required' });

  const reminder = db.prepare(`SELECT * FROM reminders WHERE id = ? AND patient_id = ?`).get(reminderId, patientId);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found' });

  db.prepare(`UPDATE reminders SET text = ?, reminder_time = ? WHERE id = ?`).run(
    text.trim(),
    reminderTime || null,
    reminderId
  );

  const updated = db.prepare(`SELECT * FROM reminders WHERE id = ?`).get(reminderId);
  res.json({ success: true, reminder: updated });
});

// Either party can delete a reminder - same shared-notebook model as adding,
// toggling, and now editing.
router.delete('/:patientId/reminders/:reminderId', requireAuth, requireLinkedPatient, (req, res) => {
  const { reminderId } = req.params;
  const patientId = Number(req.params.patientId);
  const reminder = db.prepare(`SELECT * FROM reminders WHERE id = ? AND patient_id = ?`).get(reminderId, patientId);
  if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
  db.prepare(`DELETE FROM reminders WHERE id = ? AND patient_id = ?`).run(reminderId, patientId);
  res.json({ success: true });
});

export default router;