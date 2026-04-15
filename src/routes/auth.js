import bcrypt from 'bcryptjs';
import pool from '../db.js';

export default async function authRoutes(fastify) {
  fastify.post('/api/auth/login', async (request, reply) => {
    const { email, password } = request.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password required' });
    }

    const [rows] = await pool.execute(
      'SELECT id, email, password_hash, role FROM users WHERE email = ?',
      [email]
    );

    if (rows.length === 0) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' });
    }

    request.session.userId = user.id;
    request.session.email = user.email;
    request.session.role = user.role;

    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  fastify.post('/api/auth/logout', async (request, reply) => {
    request.session.destroy();
    return { ok: true };
  });

  fastify.get('/api/auth/me', async (request, reply) => {
    if (!request.session || !request.session.userId) {
      return reply.code(401).send({ error: 'Not authenticated' });
    }
    return {
      user: {
        id: request.session.userId,
        email: request.session.email,
        role: request.session.role,
      },
    };
  });
}
