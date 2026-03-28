/**
 * ============================================================
 * Motor Estatístico - Algoritmo de Raking Iterativo (IPF)
 * Iterative Proportional Fitting - implementação em JS
 * ============================================================
 *
 * O Raking (ou IPF) é um algoritmo de ponderação estatística
 * que ajusta os pesos individuais de uma amostra para que as
 * distribuições marginais das variáveis demográficas
 * correspondam às proporções conhecidas da população.
 *
 * Exemplo de uso:
 *   - Amostra: 60% mulheres, 40% homens
 *   - Populacional: 52% mulheres, 48% homens
 *   → O algoritmo aumenta o peso dos homens e diminui das mulheres
 *
 * Referência: Deming & Stephan (1940), Battaglia et al. (2009)
 */

const db = require('../common/db');

/**
 * Executa o algoritmo de Raking IPF completo para uma pesquisa
 *
 * @param {string} surveyId - ID da pesquisa
 * @param {Object} options - Configurações do algoritmo
 * @param {number} options.maxIterations - Máximo de iterações (default: 100)
 * @param {number} options.convergenceTol - Tolerância de convergência (default: 0.001)
 * @param {number} options.weightTrimMax - Peso máximo por respondente (default: 5.0)
 * @param {boolean} options.excludeBots - Excluir respondentes detectados como bots
 * @returns {Object} Resultado com pesos e métricas de convergência
 */
async function runRaking(surveyId, options = {}) {
  const {
    maxIterations   = 100,
    convergenceTol  = 0.001,
    weightTrimMax   = 5.0,
    excludeBots     = true
  } = options;

  // ── 1. Carregar dados ──────────────────────────────────────────────────────
  const { rows: sessions } = await db.query(`
    SELECT rs.id, rs.weight,
           json_object_agg(q.demographic_key, a.value) AS demographics
    FROM response_sessions rs
    JOIN answers a ON a.session_id = rs.id
    JOIN questions q ON a.question_id = q.id
    WHERE rs.survey_id = $1
      AND rs.status = 'completed'
      AND ($2 = FALSE OR rs.is_bot = FALSE)
      AND q.demographic_key IS NOT NULL
    GROUP BY rs.id, rs.weight
  `, [surveyId, excludeBots]);

  if (sessions.length === 0) {
    throw new Error('Sem respostas suficientes para calcular ponderação.');
  }

  // ── 2. Carregar alvos populacionais ────────────────────────────────────────
  const { rows: targets } = await db.query(
    'SELECT dimension, category, proportion FROM population_targets WHERE survey_id = $1',
    [surveyId]
  );

  if (targets.length === 0) {
    throw new Error('Nenhum alvo populacional definido para esta pesquisa.');
  }

  // Organizar alvos por dimensão: { gender: { female: 0.52, male: 0.48 }, ... }
  const populationTargets = {};
  for (const t of targets) {
    if (!populationTargets[t.dimension]) populationTargets[t.dimension] = {};
    populationTargets[t.dimension][t.category] = parseFloat(t.proportion);
  }

  // ── 3. Extrair categorias de cada respondente ──────────────────────────────
  /**
   * Para cada sessão, obtém a categoria do respondente em cada dimensão.
   * demographics é um JSON: { "gender": {"choice": "female"}, "age_group": {"choice": "25-34"} }
   */
  const respondents = sessions.map(s => {
    const categories = {};
    const demo = s.demographics || {};

    for (const [dim] of Object.entries(populationTargets)) {
      const val = demo[dim];
      if (val) {
        // Valor pode ser {choice: "..."} ou {value: "..."} ou string direta
        categories[dim] = val.choice || val.value || val;
      }
    }

    return {
      id: s.id,
      weight: parseFloat(s.weight) || 1.0,
      categories
    };
  });

  const n = respondents.length;
  console.log(`\n🔢 Iniciando raking para ${n} respondentes, ${Object.keys(populationTargets).length} dimensões`);

  // ── 4. Algoritmo IPF ───────────────────────────────────────────────────────
  /**
   * O algoritmo funciona em rounds:
   * Para cada dimensão D:
   *   1. Calcular proporção atual da amostra (ponderada) em cada categoria de D
   *   2. Calcular fator de ajuste = proporção_alvo / proporção_atual
   *   3. Multiplicar o peso de cada respondente pelo fator correspondente à sua categoria em D
   * Repetir até convergência (diferença máxima entre marginal atual e alvo < tolerância)
   */
  let iterations = 0;
  let converged  = false;
  let finalError = Infinity;

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    let maxError = 0;  // Erro máximo desta iteração (para critério de convergência)

    // Para cada dimensão (ex: gender, age_group, region)
    for (const [dimension, targetProportions] of Object.entries(populationTargets)) {

      // ─ a) Calcular soma dos pesos por categoria ─────────────────────────
      const weightSumByCategory = {};
      let totalWeight = 0;

      for (const r of respondents) {
        const category = r.categories[dimension];
        if (!category) continue;  // Respondente não respondeu esta dimensão

        weightSumByCategory[category] = (weightSumByCategory[category] || 0) + r.weight;
        totalWeight += r.weight;
      }

      // ─ b) Calcular fator de ajuste para cada categoria ──────────────────
      for (const [category, targetProp] of Object.entries(targetProportions)) {
        const currentProp = totalWeight > 0
          ? (weightSumByCategory[category] || 0) / totalWeight
          : 0;

        if (currentProp === 0) continue;  // Categoria sem respondentes

        const adjustmentFactor = targetProp / currentProp;

        // Rastrear o maior erro para verificar convergência
        const error = Math.abs(currentProp - targetProp);
        maxError = Math.max(maxError, error);

        // ─ c) Aplicar fator de ajuste ──────────────────────────────────────
        for (const r of respondents) {
          if (r.categories[dimension] === category) {
            r.weight *= adjustmentFactor;
          }
        }
      }
    }

    finalError = maxError;

    // ─ d) Verificar convergência ───────────────────────────────────────────
    if (maxError < convergenceTol) {
      converged = true;
      console.log(`✅ Convergiu em ${iterations} iterações (erro: ${maxError.toFixed(6)})`);
      break;
    }

    if (iter % 10 === 0) {
      console.log(`   Iteração ${iterations}: erro máximo = ${maxError.toFixed(6)}`);
    }
  }

  if (!converged) {
    console.warn(`⚠️  Não convergiu em ${maxIterations} iterações (erro final: ${finalError.toFixed(6)})`);
  }

  // ── 5. Weight Trimming ────────────────────────────────────────────────────
  /**
   * Limita pesos extremos que podem distorcer resultados.
   * Pesos muito altos (ex: 10x a média) inflam a influência de poucos respondentes.
   *
   * Estratégia: trim e renormalização iterativa
   */
  let trimmedCount = 0;
  const meanWeight = respondents.reduce((s, r) => s + r.weight, 0) / n;
  const maxAllowedWeight = meanWeight * weightTrimMax;

  for (const r of respondents) {
    if (r.weight > maxAllowedWeight) {
      r.weight = maxAllowedWeight;
      trimmedCount++;
    }
  }

  // Renormalizar para que a soma dos pesos = n (tamanho da amostra)
  const totalWeightAfterTrim = respondents.reduce((s, r) => s + r.weight, 0);
  for (const r of respondents) {
    r.weight = (r.weight / totalWeightAfterTrim) * n;
  }

  if (trimmedCount > 0) {
    console.log(`✂️  Pesos cortados: ${trimmedCount} respondentes (>${weightTrimMax}x a média)`);
  }

  // ── 6. Calcular métricas finais ────────────────────────────────────────────
  const weights = respondents.map(r => r.weight);
  const wMin    = Math.min(...weights);
  const wMax    = Math.max(...weights);
  const wMean   = weights.reduce((s, w) => s + w, 0) / n;
  const wStd    = Math.sqrt(
    weights.reduce((s, w) => s + Math.pow(w - wMean, 2), 0) / n
  );

  /**
   * Design Effect (DEFF): mede o quanto a ponderação aumenta a variância
   * DEFF = 1 + (Coef.Variação dos pesos)²
   * DEFF = 1 significa sem perda, DEFF = 2 significa que precisa-se do dobro da amostra
   */
  const cv    = wStd / wMean;
  const deff  = 1 + Math.pow(cv, 2);
  const nEff  = Math.round(n / deff);  // Tamanho efetivo da amostra

  console.log(`\n📊 Resumo do raking:`);
  console.log(`   N = ${n} | N efetivo = ${nEff} | DEFF = ${deff.toFixed(3)}`);
  console.log(`   Peso: min=${wMin.toFixed(3)} | max=${wMax.toFixed(3)} | média=${wMean.toFixed(3)} | dp=${wStd.toFixed(3)}`);

  // ── 7. Salvar pesos no banco ───────────────────────────────────────────────
  await db.transaction(async (client) => {
    for (const r of respondents) {
      await client.query(
        'UPDATE response_sessions SET weight = $1 WHERE id = $2',
        [r.weight, r.id]
      );
    }
  });

  return {
    n,
    n_effective: nEff,
    design_effect: deff,
    converged,
    iterations_used: iterations,
    final_error: finalError,
    trimmed_count: trimmedCount,
    weight_stats: { min: wMin, max: wMax, mean: wMean, std: wStd, cv },
    weights: respondents.map(r => ({ id: r.id, weight: r.weight }))
  };
}

/**
 * Calcula a margem de erro com base nos resultados ponderados
 *
 * @param {number} proportion - Proporção observada (0 a 1)
 * @param {number} nEffective - Tamanho efetivo da amostra
 * @param {number} confidenceLevel - Nível de confiança (default: 0.95)
 * @returns {Object} margem de erro e intervalo de confiança
 */
function calculateMarginOfError(proportion, nEffective, confidenceLevel = 0.95) {
  // Z-score para o nível de confiança (tabela normal)
  const zScores = { 0.90: 1.645, 0.95: 1.960, 0.99: 2.576 };
  const z = zScores[confidenceLevel] || 1.960;

  // Erro padrão da proporção
  const standardError = Math.sqrt((proportion * (1 - proportion)) / nEffective);

  // Margem de erro
  const marginOfError = z * standardError;

  return {
    proportion,
    margin_of_error: marginOfError,
    margin_of_error_pct: (marginOfError * 100).toFixed(1) + '%',
    confidence_interval: {
      lower: Math.max(0, proportion - marginOfError),
      upper: Math.min(1, proportion + marginOfError)
    },
    confidence_level: confidenceLevel,
    n_effective: nEffective
  };
}

/**
 * Calcula resultados ponderados de uma pergunta de escolha simples
 *
 * @param {string} surveyId - ID da pesquisa
 * @param {string} questionId - ID da pergunta
 * @returns {Array} Distribuição ponderada das respostas
 */
async function getWeightedResults(surveyId, questionId) {
  const { rows } = await db.query(`
    SELECT
      a.value->>'choice' AS choice,
      SUM(rs.weight) AS weighted_count,
      COUNT(*) AS raw_count,
      SUM(rs.weight) / SUM(SUM(rs.weight)) OVER () AS weighted_proportion
    FROM answers a
    JOIN response_sessions rs ON a.session_id = rs.id
    WHERE a.survey_id = $1
      AND a.question_id = $2
      AND rs.status = 'completed'
      AND rs.is_bot = FALSE
    GROUP BY a.value->>'choice'
    ORDER BY weighted_proportion DESC
  `, [surveyId, questionId]);

  return rows.map(row => ({
    choice: row.choice,
    raw_count: parseInt(row.raw_count),
    weighted_count: parseFloat(row.weighted_count),
    weighted_proportion: parseFloat(row.weighted_proportion)
  }));
}

module.exports = { runRaking, calculateMarginOfError, getWeightedResults };
