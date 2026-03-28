/**
 * Conexão com PostgreSQL usando pool de conexões
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('Erro inesperado no pool de conexões:', err);
});

/**
 * Executa uma query SQL
 * @param {string} text - Query SQL
 * @param {Array} params - Parâmetros da query
 */
const query = (text, params) => pool.query(text, params);

/**
 * Obtém um cliente do pool para transações
 */
const getClient = () => pool.connect();

/**
 * Executa múltiplas queries em uma transação
 * @param {Function} callback - Função que recebe o cliente e executa queries
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { query, getClient, transaction };
