/**
 * Export Routes - CSV, Excel, JSON
 */

const express  = require('express');
const ExcelJS  = require('exceljs');
const db       = require('../common/db');
const { authenticate } = require('../auth/auth.middleware');

const router = express.Router();
router.use(authenticate);

// ─── Função auxiliar: buscar dados completos da pesquisa ─────────────────────
async function fetchSurveyData(surveyId) {
  const { rows: sessions } = await db.query(`
    SELECT rs.id, rs.started_at, rs.completed_at, rs.status,
           rs.country, rs.region, rs.weight, rs.fraud_score, rs.is_bot
    FROM response_sessions rs
    WHERE rs.survey_id = $1 AND rs.status = 'completed'
    ORDER BY rs.completed_at
  `, [surveyId]);

  const { rows: questions } = await db.query(
    'SELECT id, order_index, text, type, demographic_key FROM questions WHERE survey_id = $1 ORDER BY order_index',
    [surveyId]
  );

  const { rows: answers } = await db.query(
    'SELECT session_id, question_id, value FROM answers WHERE survey_id = $1',
    [surveyId]
  );

  // Montar respostas indexadas por sessão
  const answersBySession = {};
  for (const a of answers) {
    if (!answersBySession[a.session_id]) answersBySession[a.session_id] = {};
    answersBySession[a.session_id][a.question_id] = a.value;
  }

  return { sessions, questions, answersBySession };
}

/**
 * Extrai o valor textual de uma resposta para exportação
 */
function extractValue(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (value.choice) return value.choice;
  if (value.choices) return value.choices.join('; ');
  if (value.score !== undefined) return value.score;
  if (value.text) return value.text;
  return JSON.stringify(value);
}

// ─── GET /api/export/:surveyId/json ──────────────────────────────────────────
router.get('/:surveyId/json', async (req, res, next) => {
  try {
    const { sessions, questions, answersBySession } = await fetchSurveyData(req.params.surveyId);

    const rows = sessions.map(s => {
      const row = {
        session_id: s.id,
        started_at: s.started_at,
        completed_at: s.completed_at,
        country: s.country,
        region: s.region,
        weight: parseFloat(s.weight),
        fraud_score: parseFloat(s.fraud_score),
        is_bot: s.is_bot
      };
      const sessionAnswers = answersBySession[s.id] || {};
      for (const q of questions) {
        row[`q${q.order_index + 1}_${q.text.slice(0, 30).replace(/\s/g, '_')}`] =
          extractValue(sessionAnswers[q.id]);
      }
      return row;
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="pesquisa_${req.params.surveyId}.json"`);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── GET /api/export/:surveyId/csv ────────────────────────────────────────────
router.get('/:surveyId/csv', async (req, res, next) => {
  try {
    const { sessions, questions, answersBySession } = await fetchSurveyData(req.params.surveyId);

    const headers = [
      'session_id', 'started_at', 'completed_at',
      'country', 'region', 'weight', 'fraud_score', 'is_bot',
      ...questions.map(q => `q${q.order_index + 1}: ${q.text.slice(0, 40)}`)
    ];

    const csvRows = sessions.map(s => {
      const sessionAnswers = answersBySession[s.id] || {};
      return [
        s.id, s.started_at, s.completed_at,
        s.country || '', s.region || '', s.weight, s.fraud_score, s.is_bot,
        ...questions.map(q => extractValue(sessionAnswers[q.id]))
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
    });

    const csv = [headers.map(h => `"${h}"`).join(','), ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="pesquisa_${req.params.surveyId}.csv"`);
    res.send('\uFEFF' + csv);  // BOM para Excel reconhecer UTF-8
  } catch (err) { next(err); }
});

// ─── GET /api/export/:surveyId/excel ──────────────────────────────────────────
router.get('/:surveyId/excel', async (req, res, next) => {
  try {
    const { sessions, questions, answersBySession } = await fetchSurveyData(req.params.surveyId);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Plataforma de Pesquisas';

    // ── Aba 1: Dados brutos ────────────────────────────────────────────────
    const wsData = workbook.addWorksheet('Respostas');
    wsData.columns = [
      { header: 'Session ID', key: 'id', width: 36 },
      { header: 'Início', key: 'started_at', width: 20 },
      { header: 'Conclusão', key: 'completed_at', width: 20 },
      { header: 'País', key: 'country', width: 8 },
      { header: 'Região', key: 'region', width: 20 },
      { header: 'Peso', key: 'weight', width: 10 },
      { header: 'Fraude Score', key: 'fraud_score', width: 12 },
      ...questions.map(q => ({
        header: `Q${q.order_index + 1}: ${q.text.slice(0, 40)}`,
        key: `q_${q.id}`,
        width: 25
      }))
    ];

    // Estilo do cabeçalho
    wsData.getRow(1).eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A56DB' } };
    });

    sessions.forEach(s => {
      const sessionAnswers = answersBySession[s.id] || {};
      const row = {
        id: s.id,
        started_at: new Date(s.started_at),
        completed_at: s.completed_at ? new Date(s.completed_at) : null,
        country: s.country || '',
        region: s.region || '',
        weight: parseFloat(s.weight)
      };
      for (const q of questions) {
        row[`q_${q.id}`] = extractValue(sessionAnswers[q.id]);
      }
      wsData.addRow(row);
    });

    // ── Aba 2: Sumário estatístico ─────────────────────────────────────────
    const wsSummary = workbook.addWorksheet('Sumário');
    wsSummary.addRow(['Métrica', 'Valor']);
    wsSummary.addRow(['Total de respondentes', sessions.length]);
    wsSummary.addRow(['Peso médio', (sessions.reduce((s, r) => s + parseFloat(r.weight), 0) / sessions.length).toFixed(4)]);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pesquisa_${req.params.surveyId}.xlsx"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) { next(err); }
});

module.exports = router;
