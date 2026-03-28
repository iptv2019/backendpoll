/**
 * Survey Routes - CRUD completo de pesquisas e perguntas
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const db      = require('../common/db');
const { authenticate } = require('../auth/auth.middleware');

const router = express.Router();

// Todas as rotas de surveys requerem autenticação
router.use(authenticate);

// ─── GET /api/surveys ────────────────────────────────────────────────────────
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await db.query(`
      SELECT
        s.*,
        u.name AS creator_name,
        COUNT(DISTINCT rs.id) FILTER (WHERE rs.status = 'completed') AS total_responses,
        COUNT(DISTINCT rs.id) AS total_sessions
      FROM surveys s
      LEFT JOIN users u ON s.created_by = u.id
      LEFT JOIN response_sessions rs ON s.id = rs.survey_id
      WHERE s.created_by = $1 OR $2 = 'superadmin'
      GROUP BY s.id, u.name
      ORDER BY s.created_at DESC
    `, [req.user.id, req.user.role]);

    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /api/surveys/:id ────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const { rows: surveys } = await db.query(
      'SELECT * FROM surveys WHERE id = $1', [req.params.id]
    );
    if (!surveys.length) return res.status(404).json({ error: 'Pesquisa não encontrada.' });

    const { rows: questions } = await db.query(
      'SELECT * FROM questions WHERE survey_id = $1 ORDER BY order_index',
      [req.params.id]
    );
    const { rows: quotas } = await db.query(
      'SELECT * FROM quotas WHERE survey_id = $1', [req.params.id]
    );
    const { rows: targets } = await db.query(
      'SELECT * FROM population_targets WHERE survey_id = $1', [req.params.id]
    );

    res.json({ ...surveys[0], questions, quotas, population_targets: targets });
  } catch (err) { next(err); }
});

// ─── POST /api/surveys ───────────────────────────────────────────────────────
router.post('/', [
  body('title').trim().isLength({ min: 3, max: 500 }),
  body('status').optional().isIn(['draft', 'active', 'closed'])
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const {
      title, description, status, starts_at, ends_at,
      allow_anonymous, require_login, randomize_questions,
      max_responses_per_ip, fingerprint_check,
      questions = [], quotas = [], population_targets = []
    } = req.body;

    const result = await db.transaction(async (client) => {
      // Criar pesquisa
      const { rows: [survey] } = await client.query(`
        INSERT INTO surveys (
          created_by, title, description, status,
          starts_at, ends_at, allow_anonymous, require_login,
          randomize_questions, max_responses_per_ip, fingerprint_check
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
      `, [
        req.user.id, title, description, status || 'draft',
        starts_at, ends_at, allow_anonymous ?? true, require_login ?? false,
        randomize_questions ?? false, max_responses_per_ip ?? 1, fingerprint_check ?? true
      ]);

      // Criar perguntas
      const createdQuestions = [];
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const { rows: [question] } = await client.query(`
          INSERT INTO questions (
            survey_id, order_index, type, text, description,
            required, options, settings, show_if, demographic_key
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          RETURNING *
        `, [
          survey.id, i, q.type, q.text, q.description,
          q.required ?? true, JSON.stringify(q.options || null),
          JSON.stringify(q.settings || null), JSON.stringify(q.show_if || null),
          q.demographic_key || null
        ]);
        createdQuestions.push(question);
      }

      // Criar cotas
      for (const quota of quotas) {
        await client.query(`
          INSERT INTO quotas (survey_id, name, filters, target)
          VALUES ($1, $2, $3, $4)
        `, [survey.id, quota.name, JSON.stringify(quota.filters), quota.target]);
      }

      // Criar alvos populacionais para raking
      for (const target of population_targets) {
        await client.query(`
          INSERT INTO population_targets (survey_id, dimension, category, proportion)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (survey_id, dimension, category) DO UPDATE SET proportion = $4
        `, [survey.id, target.dimension, target.category, target.proportion]);
      }

      return { ...survey, questions: createdQuestions };
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ─── PUT /api/surveys/:id ────────────────────────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    const { title, description, status, starts_at, ends_at } = req.body;
    const { rows } = await db.query(`
      UPDATE surveys SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        status = COALESCE($3, status),
        starts_at = COALESCE($4, starts_at),
        ends_at = COALESCE($5, ends_at),
        updated_at = NOW()
      WHERE id = $6
      RETURNING *
    `, [title, description, status, starts_at, ends_at, req.params.id]);

    if (!rows.length) return res.status(404).json({ error: 'Pesquisa não encontrada.' });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// ─── DELETE /api/surveys/:id ─────────────────────────────────────────────────
router.delete('/:id', async (req, res, next) => {
  try {
    await db.query('DELETE FROM surveys WHERE id = $1', [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ─── POST /api/surveys/:id/duplicate ─────────────────────────────────────────
router.post('/:id/duplicate', async (req, res, next) => {
  try {
    const result = await db.transaction(async (client) => {
      const { rows: [orig] } = await client.query(
        'SELECT * FROM surveys WHERE id = $1', [req.params.id]
      );
      if (!orig) throw Object.assign(new Error('Não encontrado'), { status: 404 });

      const { rows: [copy] } = await client.query(`
        INSERT INTO surveys (created_by, title, description, allow_anonymous,
          require_login, randomize_questions, max_responses_per_ip, fingerprint_check)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
      `, [
        req.user.id, `${orig.title} (cópia)`, orig.description,
        orig.allow_anonymous, orig.require_login, orig.randomize_questions,
        orig.max_responses_per_ip, orig.fingerprint_check
      ]);

      // Duplicar perguntas
      const { rows: origQs } = await client.query(
        'SELECT * FROM questions WHERE survey_id = $1 ORDER BY order_index', [orig.id]
      );
      for (const q of origQs) {
        await client.query(`
          INSERT INTO questions (survey_id, order_index, type, text, description,
            required, options, settings, show_if, demographic_key)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [copy.id, q.order_index, q.type, q.text, q.description,
            q.required, q.options, q.settings, q.show_if, q.demographic_key]);
      }

      return copy;
    });

    res.status(201).json(result);
  } catch (err) { next(err); }
});

// ─── POST /api/surveys/:id/population-targets ────────────────────────────────
// Upload de alvos populacionais via JSON (para uso com raking)
router.post('/:id/population-targets', async (req, res, next) => {
  try {
    const targets = req.body.targets; // [{dimension, category, proportion}]
    if (!Array.isArray(targets)) {
      return res.status(400).json({ error: 'Envie um array "targets".' });
    }

    // Valida que proporções somam ~1.0 por dimensão
    const byDimension = {};
    for (const t of targets) {
      byDimension[t.dimension] = (byDimension[t.dimension] || 0) + parseFloat(t.proportion);
    }
    for (const [dim, sum] of Object.entries(byDimension)) {
      if (Math.abs(sum - 1.0) > 0.01) {
        return res.status(400).json({
          error: `Proporções da dimensão "${dim}" somam ${sum.toFixed(4)}, esperado 1.0`
        });
      }
    }

    await db.query(
      'DELETE FROM population_targets WHERE survey_id = $1', [req.params.id]
    );
    for (const t of targets) {
      await db.query(`
        INSERT INTO population_targets (survey_id, dimension, category, proportion)
        VALUES ($1, $2, $3, $4)
      `, [req.params.id, t.dimension, t.category, t.proportion]);
    }

    res.json({ message: 'Alvos populacionais salvos.', count: targets.length });
  } catch (err) { next(err); }
});

module.exports = router;
