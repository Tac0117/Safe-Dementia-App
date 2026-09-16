import { Router } from 'express';
import { db } from '../db/index.js';
import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { createSession, destroySession } from '../auth/sessions.js';
import { setSessionCookie, clearSessionCookie, requireAuth, requireRole, COOKIE_NAME } from '../auth/middleware.js';

const router = Router();

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Caregiver self-registration.
router.post('/signup/caregiver', (req, res) => {
  const { email, password, name } = req.body;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const { hash, salt } = hashPassword(password);
  const info = db
    .prepare(`INSERT INTO users (email, password_hash, password_salt, role, name) VALUES (?, ?, ?, 'caregiver', ?)`)
    .run(email, hash, salt, name.trim());

  const token = createSession(info.lastInsertRowid);
  setSessionCookie(res, token);
  res.json({ success: true, user: { id: info.lastInsertRowid, email, name, role: 'caregiver' } });
});

// A patient account is created BY their caregiver (common for this population —
// the person may not be able to self-register), which is also the moment the
// caregiver_patient_link is created. The UNIQUE constraint on patient_id in
// that table is what enforces "one caregiver per patient" at the DB level.
router.post('/patients', requireAuth, requireRole('caregiver'), (req, res) => {
  const { email, password, name, age, condition, emergencyPhone } = req.body;
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Valid email required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Patient name required' });

  const existing = db.prepare(`SELECT id FROM users WHERE email = ?`).get(email);
  if (existing) return res.status(409).json({ error: 'An account with that email already exists' });

  const { hash, salt } = hashPassword(password);

  const tx = db.exec ? null : null; // node:sqlite has no explicit tx helper here; use manual BEGIN/COMMIT
  db.exec('BEGIN');
  try {
    const userInfo = db
      .prepare(`INSERT INTO users (email, password_hash, password_salt, role, name) VALUES (?, ?, ?, 'patient', ?)`)
      .run(email, hash, salt, name.trim());
    const patientId = userInfo.lastInsertRowid;

    db.prepare(`INSERT INTO caregiver_patient_links (caregiver_id, patient_id) VALUES (?, ?)`)
      .run(req.user.id, patientId);

    db.prepare(
      `INSERT INTO patient_profiles (patient_id, age, condition, emergency_phone, safe_radius_meters, safe_zone_enabled)
       VALUES (?, ?, ?, ?, 400, 1)`
    ).run(patientId, age ? Number(age) : null, condition || null, emergencyPhone || null);

    db.exec('COMMIT');
    res.json({ success: true, patient: { id: patientId, email, name: name.trim(), role: 'patient' } });
  } catch (err) {
    db.exec('ROLLBACK');
    // UNIQUE constraint on patient_id fires only if a patient row is inserted twice for
    // the same link, which can't happen from this path — this catch is mainly for
    // unexpected DB errors, kept honest rather than swallowed.
    console.error('Add patient failed:', err);
    res.status(500).json({ error: 'Could not create patient account' });
  }
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  const user = db.prepare(`SELECT * FROM users WHERE email = ?`).get(email);
  if (!user || !verifyPassword(password, user.password_salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = createSession(user.id);
  setSessionCookie(res, token);
  res.json({ success: true, user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post('/logout', (req, res) => {
  destroySession(req.cookies?.[COOKIE_NAME]);
  clearSessionCookie(res);
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => {
  if (req.user.role === 'caregiver') {
    const patients = db
      .prepare(
        `SELECT u.id, u.name, u.email, p.is_missing
         FROM caregiver_patient_links l
         JOIN users u ON u.id = l.patient_id
         LEFT JOIN patient_profiles p ON p.patient_id = u.id
         WHERE l.caregiver_id = ?`
      )
      .all(req.user.id);
    return res.json({ user: req.user, patients });
  }

  const link = db.prepare(`SELECT caregiver_id FROM caregiver_patient_links WHERE patient_id = ?`).get(req.user.id);
  const caregiver = link ? db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(link.caregiver_id) : null;
  res.json({ user: req.user, caregiver });
});

export default router;
