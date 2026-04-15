import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import pool from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/session-auth.js';

export default async function serverRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List all servers with process counts
  fastify.get('/api/servers', async () => {
    const [rows] = await pool.execute(`
      SELECT s.*,
        (SELECT COUNT(*) FROM processes p WHERE p.server_id = s.id) as process_count,
        (SELECT COUNT(*) FROM processes p WHERE p.server_id = s.id AND p.status = 'running') as running_count
      FROM servers s ORDER BY s.name
    `);
    return { servers: rows };
  });

  // Server detail
  fastify.get('/api/servers/:id', async (request) => {
    const [rows] = await pool.execute('SELECT * FROM servers WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Not found' };
    return { server: rows[0] };
  });

  // Add new server (generates token)
  fastify.post('/api/servers', { preHandler: [requireAdmin] }, async (request) => {
    const { name } = request.body || {};
    if (!name) return { error: 'Server name required' };

    const id = uuidv4();
    const agentToken = crypto.randomBytes(32).toString('hex');

    await pool.execute(
      'INSERT INTO servers (id, name, agent_token) VALUES (?, ?, ?)',
      [id, name, agentToken]
    );

    return {
      server: { id, name, agent_token: agentToken },
      message: 'Copy the agent_token into the agent config on your monitored server.',
    };
  });

  // Delete server
  fastify.delete('/api/servers/:id', { preHandler: [requireAdmin] }, async (request) => {
    await pool.execute('DELETE FROM servers WHERE id = ?', [request.params.id]);
    return { ok: true };
  });
}
