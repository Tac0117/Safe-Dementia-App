import { Router } from 'express';
import { db } from '../db/index.js';
import { requireAuth, requireLinkedPatient } from '../auth/middleware.js';

const router = Router();

router.get('/:patientId/messages', requireAuth, requireLinkedPatient, (req, res) => {
  const rows = db
    .prepare(
      `SELECT m.id, m.sender_role, m.text, m.read_at, m.created_at, u.name as sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id
       WHERE m.link_id = ? ORDER BY m.created_at ASC`
    )
    .all(req.link.id);
  res.json(rows);
});

router.post('/:patientId/messages', requireAuth, requireLinkedPatient, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text required' });

  const info = db
    .prepare(
      `INSERT INTO messages (link_id, sender_id, sender_role, text) VALUES (?, ?, ?, ?)`
    )
    .run(req.link.id, req.user.id, req.user.role, text.trim());

  const message = db
    .prepare(
      `SELECT m.id, m.sender_role, m.text, m.read_at, m.created_at, u.name as sender_name
       FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`
    )
    .get(info.lastInsertRowid);

  res.json({ success: true, message });
});

router.post('/:patientId/messages/read', requireAuth, requireLinkedPatient, (req, res) => {
  // Mark as read only the messages sent by the OTHER party (a caregiver
  // reading marks the patient's messages read, and vice versa).
  db.prepare(
    `UPDATE messages SET read_at = datetime('now') WHERE link_id = ? AND sender_role != ? AND read_at IS NULL`
  ).run(req.link.id, req.user.role);
  res.json({ success: true });
});

export default router;
