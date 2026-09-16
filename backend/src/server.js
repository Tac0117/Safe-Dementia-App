import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

import './db/index.js'; // boots the SQLite DB + runs schema on import
import { cookieParserMiddleware } from './auth/middleware.js';

import authRoutes from './routes/auth.js';
import patientRoutes from './routes/patients.js';
import messageRoutes from './routes/messages.js';
import emergencyRoutes from './routes/emergency.js';
import mlRoutes from './routes/ml.js';
import aiChatRoutes from './routes/aiChat.js';
import reminderRoutes from './routes/reminders.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(cookieParserMiddleware);

const frontendDist = path.join(__dirname, '../../frontend/dist');
app.use(express.static(frontendDist));

app.use('/api/auth', authRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/patients', messageRoutes);
app.use('/api/patients', emergencyRoutes);
app.use('/api/patients', mlRoutes);
app.use('/api/patients', aiChatRoutes);
app.use('/api/patients', reminderRoutes);

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('*', (req, res) => {
  res.sendFile(path.join(frontendDist, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(` Safe Dementia backend running on port ${PORT}`);
  console.log(` SQLite DB + account auth + per-patient trained ML`);
  console.log(`====================================================`);
});
