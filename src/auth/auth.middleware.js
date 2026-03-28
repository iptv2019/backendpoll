/**
 * Middleware de autenticação JWT
 */

const jwt = require('jsonwebtoken');
const db  = require('../common/db');

/**
 * Verifica o token JWT e injeta o usuário na requisição
 */
const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de autenticação não fornecido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await db.query(
      'SELECT id, email, name, role FROM users WHERE id = $1',
      [decoded.sub]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Usuário não encontrado.' });
    }
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
};

/**
 * Exige que o usuário seja superadmin
 */
const requireSuperAdmin = (req, res, next) => {
  if (req.user?.role !== 'superadmin') {
    return res.status(403).json({ error: 'Permissão insuficiente.' });
  }
  next();
};

module.exports = { authenticate, requireSuperAdmin };
