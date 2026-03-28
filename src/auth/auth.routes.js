/**
 * Auth: login, registro e refresh de token
 */

const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const db      = require('../common/db');
const { authenticate } = require('./auth.middleware');

const router = express.Router();

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 })
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password } = req.body;
    const { rows } = await db.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    if (!rows.length) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Credenciais inválidas.' });
    }

    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name, role: user.role }
    });
  } catch (err) { next(err); }
});

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', authenticate, [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  body('name').trim().isLength({ min: 2 })
], async (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { email, password, name } = req.body;
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await db.query(
      `INSERT INTO users (email, password, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, role`,
      [email, hashed, name]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'E-mail já cadastrado.' });
    }
    next(err);
  }
});

// ─── GET /api/auth/me ────────────────────────────────────────────────────────
router.get('/me', authenticate, (req, res) => {
  res.json(req.user);
});

module.exports = router;
