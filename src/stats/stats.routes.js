/**
 * Stats Routes - Dashboard, raking e resultados ponderados
 */

const express = require('express');
const db      = require('../common/db');
const { authenticate } = require('../auth/auth.middleware');
const { runRaking, calculateMarginOfError, getWeightedResults } = require('./raking.service');

const router = express.Router();
router.use(authenticate);

// ─── POST /api/stats/:surveyId/run-weighting ─────────────────────────────────
// Dispara o algoritmo de raking para a pesquisa
router.post('/:surveyId/run-weighting', async (req, res, next) => {
  try {
    const {
      max_iterations   = 100,
      convergence_tol  = 0.001,
      weight_trim_max  = 5.0,
      exclude_bots     = true
    } = req.body;

    // Registrar execução no banco
    const { rows: [run] } = await db.query(`
      INSERT INTO weighting_runs (survey_id, max_iterations, convergence_tol, weight_trim_max)
      VALUES ($1, $2, $3, $4) RETURNING id
    `, [req.params.surveyId, max_iterations, convergence_tol, weight_trim_max]);

    // Executar raking (pode ser assíncrono com queue em produção)
    await db.query(
      "UPDATE weighting_runs SET status = 'running' WHERE id = $1", [run.id]
    );

    const result = await runRaking(req.params.surveyId, {
      maxIterations: max_iterations,
      convergenceTol: convergence_tol,
      weightTrimMax: weight_trim_max,
      excludeBots: exclude_bots
    });

    // Salvar resultados
    await db.query(`
      UPDATE weighting_runs SET
        status = 'done',
        iterations_used = $1,
        converged = $2,
        final_error = $3,
        summary = $4,
        completed_at = NOW()
      WHERE id = $5
    `, [
      result.iterations_used, result.converged, result.final_error,
      JSON.stringify({
        n: result.n,
        n_effective: result.n_effective,
        design_effect: result.design_effect,
        weight_stats: result.weight_stats,
        trimmed_count: result.trimmed_count
      }),
      run.id
    ]);

    res.json({ run_id: run.id, ...result });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/stats/:surveyId/dashboard ──────────────────────────────────────
// Dashboard principal da pesquisa
router.get('/:surveyId/dashboard', async (req, res, next) => {
  try {
    const [sessionsRes, answersRes, demographicsRes, lastRunRes] = await Promise.all([
      // Métricas de sessão
      db.query(`
        SELECT
          COUNT(*) AS total,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed,
          COUNT(*) FILTER (WHERE status = 'abandoned') AS abandoned,
          COUNT(*) FILTER (WHERE is_bot = TRUE) AS bots,
          AVG(EXTRACT(EPOCH FROM (completed_at - started_at))) FILTER (WHERE status = 'completed') AS avg_time_seconds
        FROM response_sessions WHERE survey_id = $1
      `, [req.params.surveyId]),

      // Respostas por dia (últimos 30 dias)
      db.query(`
        SELECT DATE(completed_at) AS day, COUNT(*) AS count
        FROM response_sessions
        WHERE survey_id = $1
          AND status = 'completed'
          AND completed_at > NOW() - INTERVAL '30 days'
        GROUP BY DATE(completed_at) ORDER BY day
      `, [req.params.surveyId]),

      // Distribuição demográfica
      db.query(`
        SELECT q.demographic_key, a.value->>'choice' AS category, COUNT(*) AS count
        FROM answers a
        JOIN questions q ON a.question_id = q.id
        JOIN response_sessions rs ON a.session_id = rs.id
        WHERE a.survey_id = $1
          AND q.demographic_key IS NOT NULL
          AND rs.status = 'completed'
        GROUP BY q.demographic_key, category
      `, [req.params.surveyId]),

      // Último raking executado
      db.query(`
        SELECT * FROM weighting_runs
        WHERE survey_id = $1 AND status = 'done'
        ORDER BY completed_at DESC LIMIT 1
      `, [req.params.surveyId])
    ]);

    const s = sessionsRes.rows[0];
    const completionRate = s.total > 0
      ? ((s.completed / s.total) * 100).toFixed(1)
      : 0;

    res.json({
      overview: {
        total_sessions: parseInt(s.total),
        completed: parseInt(s.completed),
        abandoned: parseInt(s.abandoned),
        suspected_bots: parseInt(s.bots),
        completion_rate: parseFloat(completionRate),
        avg_response_time_min: s.avg_time_seconds
          ? (s.avg_time_seconds / 60).toFixed(1) : null
      },
      responses_by_day: answersRes.rows,
      demographics: demographicsRes.rows,
      last_weighting: lastRunRes.rows[0] || null
    });
  } catch (err) { next(err); }
});

// ─── GET /api/stats/:surveyId/question/:questionId/weighted ──────────────────
// Resultados ponderados de uma pergunta com margem de erro
router.get('/:surveyId/question/:questionId/weighted', async (req, res, next) => {
  try {
    const results = await getWeightedResults(req.params.surveyId, req.params.questionId);

    // Pegar N efetivo do último raking
    const { rows: [lastRun] } = await db.query(`
      SELECT summary FROM weighting_runs
      WHERE survey_id = $1 AND status = 'done'
      ORDER BY completed_at DESC LIMIT 1
    `, [req.params.surveyId]);

    const nEffective = lastRun?.summary?.n_effective || results.reduce((s, r) => s + r.raw_count, 0);

    // Calcular margem de erro para cada resultado
    const withMoe = results.map(r => ({
      ...r,
      ...calculateMarginOfError(r.weighted_proportion, nEffective)
    }));

    res.json({ results: withMoe, n_effective: nEffective });
  } catch (err) { next(err); }
});

// ─── GET /api/stats/:surveyId/weighting-history ──────────────────────────────
router.get('/:surveyId/weighting-history', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT id, status, iterations_used, converged, final_error,
             summary, created_at, completed_at
      FROM weighting_runs WHERE survey_id = $1
      ORDER BY created_at DESC LIMIT 10
    `, [req.params.surveyId]);
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
