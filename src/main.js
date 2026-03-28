/**
 * Plataforma de Pesquisas Online - Backend API
 * Configurado para deploy no Render.com
 */

require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');
const rateLimit   = require('express-rate-limit');

const authRoutes     = require('./auth/auth.routes');
const surveyRoutes   = require('./surveys/survey.routes');
const responseRoutes = require('./responses/response.routes');
const statsRoutes    = require('./stats/stats.routes');
const exportRoutes   = require('./stats/export.routes');

const app = express();

app.use(helmet());
app.use(compression());
app.use(morgan('combined'));

// CORS: aceita localhost em dev e domínio Vercel em produção
const allowedOrigins = [
  'http://localhost:3000',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      return callback(null, true);
    }
    callback(new Error('CORS bloqueado: ' + origin));
  },
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições, tente novamente em breve.' }
}));

app.use('/api/auth',      authRoutes);
app.use('/api/surveys',   surveyRoutes);
app.use('/api/responses', responseRoutes);
app.use('/api/stats',     statsRoutes);
app.use('/api/export',    exportRoutes);

// Health check — obrigatório no Render
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log('API rodando na porta ' + PORT);
});

module.exports = app;
