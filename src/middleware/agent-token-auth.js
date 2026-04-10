import pool from '../db.js';

export async function requireAgentToken(request, reply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Missing or invalid agent token' });
    return;
  }

  const token = authHeader.slice(7);
  const [rows] = await pool.execute(
    'SELECT id, name, status FROM servers WHERE agent_token = ?',
    [token]
  );

  if (rows.length === 0) {
    reply.code(401).send({ error: 'Invalid agent token' });
    return;
  }

  request.server_id = rows[0].id;
  request.server_name = rows[0].name;
}
