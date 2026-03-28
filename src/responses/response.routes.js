/**
 * Response Service - Coleta de respostas com anti-fraude e controle de cotas
 */

const express = require('express');
const crypto  = require('crypto');
const { body, validationResult } = require('express-validator');
const db      = require('../common/db');

const router = express.Router();

// ─── Funções de anti-fraude ───────────────────────────────────────────────────

/**
 * Calcula um hash do IP para preservar privacidade
 */
const hashIP = (ip) =>
  crypto.createHash('sha256').update(ip + process.env.JWT_SECRET).digest('hex');

/**
 * Detecta padrões suspeitos de bot/fraude
 * Retorna score de 0 (legítimo) a 1 (bot)
 */
const calculateFraudScore = (req, timeToComplete) => {
  let score = 0;

  // Resposta muito rápida (menos de 5s) é suspeito
  if (timeToComplete < 5000) score += 0.4;
  else if (timeToComplete < 15000) score += 0.2;

  // Sem user-agent ou user-agent genérico
  const ua = req.headers['user-agent'] || '';
  if (!ua || ua.includes('bot') || ua.includes('spider')) score += 0.3;
  if (ua.includes('curl') || ua.includes('python')) score += 0.2;

  // Sem referer também é suspeito para formulários
  // if (!req.headers['referer']) score += 0.1;

  return Math.min(score, 1.0);
};

// ─── GET /api/responses/survey/:surveyId/public ──────────────────────────────
// Retorna os dados públicos da pesquisa para o respondente
router.get('/survey/:surveyId/public', async (req, res, next) => {
  try {
    const { rows: surveys } = await db.query(`
      SELECT id, title, description, allow_anonymous, require_login,
             randomize_questions, starts_at, ends_at, status
      FROM surveys WHERE id = $1
    `, [req.params.surveyId]);

    if (!surveys.length || surveys[0].status !== 'active') {
      return res.status(404).json({ error: 'Pesquisa não encontrada ou não está ativa.' });
    }

    const survey = surveys[0];

    // Verificar se está no período válido
    const now = new Date();
    if (survey.starts_at && now < new Date(survey.starts_at)) {
      return res.status(403).json({ error: 'Esta pesquisa ainda não começou.' });
    }
    if (survey.ends_at && now > new Date(survey.ends_at)) {
      return res.status(403).json({ error: 'Esta pesquisa já foi encerrada.' });
    }

    // Buscar perguntas
    const { rows: questions } = await db.query(
      'SELECT id, order_index, type, text, description, required, options, settings, show_if FROM questions WHERE survey_id = $1 ORDER BY order_index',
      [survey.id]
    );

    // Randomizar se configurado
    let finalQuestions = questions;
    if (survey.randomize_questions) {
      finalQuestions = [...questions].sort(() => Math.random() - 0.5);
    }

    res.json({ survey, questions: finalQuestions });
  } catch (err) { next(err); }
});

// ─── POST /api/responses/survey/:surveyId/start ──────────────────────────────
// Inicia uma sessão de resposta
router.post('/survey/:surveyId/start', async (req, res, next) => {
  try {
    const { fingerprint, latitude, longitude, country, region } = req.body;
    const ipHash = hashIP(req.ip);

    // Verificar se o IP já respondeu (anti-fraude)
    const { rows: surveys } = await db.query(
      'SELECT * FROM surveys WHERE id = $1 AND status = $2',
      [req.params.surveyId, 'active']
    );
    if (!surveys.length) {
      return res.status(404).json({ error: 'Pesquisa não encontrada ou inativa.' });
    }

    const survey = surveys[0];

    if (survey.max_responses_per_ip > 0) {
      const { rows: existing } = await db.query(`
        SELECT COUNT(*) as count FROM response_sessions
        WHERE survey_id = $1 AND ip_hash = $2 AND status = 'completed'
      `, [survey.id, ipHash]);

      if (parseInt(existing[0].count) >= survey.max_responses_per_ip) {
        return res.status(429).json({
          error: 'Você já respondeu esta pesquisa.',
          code: 'DUPLICATE_RESPONSE'
        });
      }
    }

    // Verificar fingerprint se configurado
    if (survey.fingerprint_check && fingerprint) {
      const { rows: fpExisting } = await db.query(`
        SELECT COUNT(*) as count FROM response_sessions
        WHERE survey_id = $1 AND fingerprint = $2 AND status = 'completed'
      `, [survey.id, fingerprint]);

      if (parseInt(fpExisting[0].count) > 0) {
        return res.status(429).json({
          error: 'Você já respondeu esta pesquisa.',
          code: 'DUPLICATE_FINGERPRINT'
        });
      }
    }

    // Criar sessão
    const { rows: [session] } = await db.query(`
      INSERT INTO response_sessions (
        survey_id, ip_hash, fingerprint, latitude, longitude, country, region
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, started_at
    `, [survey.id, ipHash, fingerprint, latitude, longitude, country, region]);

    res.json({ session_id: session.id, started_at: session.started_at });
  } catch (err) { next(err); }
});

// ─── POST /api/responses/survey/:surveyId/submit ─────────────────────────────
// Submete as respostas completas
router.post('/survey/:surveyId/submit', [
  body('session_id').isUUID(),
  body('answers').isArray({ min: 1 })
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { session_id, answers, time_to_complete } = req.body;

    // Verificar se a sessão existe e está ativa
    const { rows: sessions } = await db.query(
      'SELECT * FROM response_sessions WHERE id = $1 AND survey_id = $2',
      [session_id, req.params.surveyId]
    );
    if (!sessions.length) {
      return res.status(404).json({ error: 'Sessão não encontrada.' });
    }
    if (sessions[0].status === 'completed') {
      return res.status(409).json({ error: 'Esta sessão já foi submetida.' });
    }

    // Calcular score de fraude
    const fraudScore = calculateFraudScore(req, time_to_complete || 60000);

    // Buscar perguntas obrigatórias
    const { rows: required } = await db.query(
      'SELECT id FROM questions WHERE survey_id = $1 AND required = TRUE',
      [req.params.surveyId]
    );
    const answeredIds = new Set(answers.map(a => a.question_id));
    const missing = required.filter(q => !answeredIds.has(q.id));
    if (missing.length > 0) {
      return res.status(400).json({
        error: `${missing.length} pergunta(s) obrigatória(s) não respondidas.`
      });
    }

    // Salvar respostas em transação
    await db.transaction(async (client) => {
      for (const answer of answers) {
        await client.query(`
          INSERT INTO answers (session_id, question_id, survey_id, value)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING
        `, [session_id, answer.question_id, req.params.surveyId,
            JSON.stringify(answer.value)]);
      }

      // Atualizar sessão como completada
      await client.query(`
        UPDATE response_sessions SET
          status = 'completed',
          completed_at = NOW(),
          completion_rate = 100,
          fraud_score = $1,
          is_bot = $2
        WHERE id = $3
      `, [fraudScore, fraudScore > 0.7, session_id]);

      // Atualizar contagem de cotas
      await updateQuotas(client, req.params.surveyId, answers);
    });

    res.json({
      message: 'Respostas registradas com sucesso. Obrigado pela participação!',
      session_id
    });
  } catch (err) { next(err); }
});

/**
 * Atualiza a contagem das cotas com base nas respostas recebidas
 */
async function updateQuotas(client, surveyId, answers) {
  const { rows: quotas } = await client.query(
    'SELECT * FROM quotas WHERE survey_id = $1 AND active = TRUE',
    [surveyId]
  );

  for (const quota of quotas) {
    const filters = quota.filters;
    let matches = true;

    for (const [questionId, expectedValue] of Object.entries(filters)) {
      const answer = answers.find(a => a.question_id === questionId);
      if (!answer) { matches = false; break; }

      const val = answer.value?.choice || answer.value?.value;
      if (val !== expectedValue) { matches = false; break; }
    }

    if (matches) {
      await client.query(
        'UPDATE quotas SET current = current + 1 WHERE id = $1',
        [quota.id]
      );
    }
  }
}

// ─── GET /api/responses/survey/:surveyId/stats ───────────────────────────────
// Retorna estatísticas básicas das respostas (para o dashboard)
router.get('/survey/:surveyId/stats', async (req, res, next) => {
  try {
    const [sessions, answers, quotas] = await Promise.all([
      db.query(`
        SELECT
          COUNT(*) AS total_sessions,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE is_bot = TRUE) AS suspected_bots,
          AVG(fraud_score) AS avg_fraud_score,
          AVG(weight) AS avg_weight
        FROM response_sessions WHERE survey_id = $1
      `, [req.params.surveyId]),

      db.query(`
        SELECT q.text, q.type, q.options, a.value, COUNT(*) as count
        FROM answers a
        JOIN questions q ON a.question_id = q.id
        WHERE a.survey_id = $1
        GROUP BY q.id, q.text, q.type, q.options, a.value
        ORDER BY q.order_index
      `, [req.params.surveyId]),

      db.query(
        'SELECT * FROM quotas WHERE survey_id = $1', [req.params.surveyId]
      )
    ]);

    const s = sessions.rows[0];
    const completionRate = s.total_sessions > 0
      ? ((s.completed / s.total_sessions) * 100).toFixed(1)
      : 0;

    res.json({
      total_sessions: parseInt(s.total_sessions),
      completed: parseInt(s.completed),
      suspected_bots: parseInt(s.suspected_bots),
      completion_rate: parseFloat(completionRate),
      avg_fraud_score: parseFloat(s.avg_fraud_score || 0),
      answers_by_question: answers.rows,
      quotas: quotas.rows
    });
  } catch (err) { next(err); }
});

module.exports = router;
