-- AegisCare relational schema (SQLite via Node's built-in node:sqlite)

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('caregiver', 'patient')),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enforces: one caregiver -> many patients, one patient -> exactly one caregiver.
-- The UNIQUE constraint on patient_id is what makes "one caregiver per patient" a
-- database-level guarantee rather than something application code has to remember.
CREATE TABLE IF NOT EXISTS caregiver_patient_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caregiver_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  patient_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_links_caregiver ON caregiver_patient_links(caregiver_id);

CREATE TABLE IF NOT EXISTS patient_profiles (
  patient_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  age INTEGER,
  condition TEXT,
  emergency_phone TEXT,
  home_lat REAL,
  home_lng REAL,
  home_address TEXT,
  safe_radius_meters INTEGER DEFAULT 400,
  safe_zone_enabled INTEGER DEFAULT 1,
  current_lat REAL,
  current_lng REAL,
  current_address TEXT,
  location_updated_at TEXT,
  is_missing INTEGER DEFAULT 0,
  missing_since TEXT
);

CREATE TABLE IF NOT EXISTS location_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  status TEXT,
  distance_from_home_m REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_location_patient_time ON location_history(patient_id, created_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES caregiver_patient_links(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('caregiver', 'patient')),
  text TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_link ON messages(link_id, created_at);

CREATE TABLE IF NOT EXISTS emergency_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual_button', 'geofence_breach')),
  lat REAL,
  lng REAL,
  address TEXT,
  distance_from_home_m REAL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_emergency_patient ON emergency_events(patient_id, status);

-- Persisted, trained-from-real-data model per patient (see ml/trainer.js).
-- "params" is JSON: learned stay-points, transition frequencies, time-of-day histograms.
CREATE TABLE IF NOT EXISTS location_models (
  patient_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  params TEXT NOT NULL,
  trained_on_samples INTEGER NOT NULL,
  trained_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL CHECK (sender IN ('user', 'bot')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Simple shared notebook for reminders (e.g. "take medicine at 8am"). Either
-- the patient or their caregiver can add one and check it off; only the
-- caregiver can delete one, so a patient can't accidentally lose a reminder
-- by mis-tapping.
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by_role TEXT NOT NULL CHECK (created_by_role IN ('caregiver', 'patient')),
  text TEXT NOT NULL,
  reminder_time TEXT,
  is_done INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reminders_patient ON reminders(patient_id);
