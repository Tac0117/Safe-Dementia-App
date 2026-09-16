import { getUserFromToken } from './sessions.js';
import { db } from '../db/index.js';

const COOKIE_NAME = 'aegis_session';

// Minimal cookie parser (no `cookie-parser` package available in this environment).
export function cookieParserMiddleware(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    header.split(';').forEach((pair) => {
      const idx = pair.indexOf('=');
      if (idx === -1) return;
      const key = pair.slice(0, idx).trim();
      const val = decodeURIComponent(pair.slice(idx + 1).trim());
      req.cookies[key] = val;
    });
  }
  next();
}

export function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = 30 * 24 * 60 * 60; // 30 days, seconds
  // In production, the frontend is very likely NOT on the same origin as
  // this API - either a normal cross-domain web deployment, or (once
  // packaged with Capacitor) bundled inside the app and loaded from
  // capacitor://localhost while this API lives on its own domain. Browsers
  // strip cookies marked SameSite=Lax/Strict from those cross-site
  // requests, which would silently break login with no visible error. Using
  // SameSite=None requires Secure (HTTPS), which production already
  // assumes. Local dev keeps SameSite=Lax since it's plain http.
  const sameSite = isProd ? 'None' : 'Lax';
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=${sameSite}${isProd ? '; Secure' : ''}`
  );
}

export function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  const sameSite = isProd ? 'None' : 'Lax';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=${sameSite}${isProd ? '; Secure' : ''}`);
}

export function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  const user = getUserFromToken(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });
  req.user = user;
  next();
}

export function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `This action requires the '${role}' role` });
    }
    next();
  };
}

// Authorization (not just authentication): confirms the logged-in caregiver
// actually has a link to the :patientId in the route, or that the logged-in
// patient IS :patientId. Prevents a caregiver from reaching a patient that
// isn't theirs just by guessing an id.
export function requireLinkedPatient(req, res, next) {
  const patientId = Number(req.params.patientId);
  if (!patientId) return res.status(400).json({ error: 'patientId required' });

  if (req.user.role === 'patient') {
    if (req.user.id !== patientId) return res.status(403).json({ error: 'Not your account' });
    req.link = db
      .prepare(`SELECT * FROM caregiver_patient_links WHERE patient_id = ?`)
      .get(patientId);
    return next();
  }

  // caregiver
  const link = db
    .prepare(
      `SELECT * FROM caregiver_patient_links WHERE caregiver_id = ? AND patient_id = ?`
    )
    .get(req.user.id, patientId);

  if (!link) return res.status(403).json({ error: 'This patient is not linked to your account' });
  req.link = link;
  next();
}

export { COOKIE_NAME };