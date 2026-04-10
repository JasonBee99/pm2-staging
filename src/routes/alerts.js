import pool from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/session-auth.js';

export default async function alertRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/api/alerts', async () => {
    const [rows] = await pool.execute(`
      SELECT a.*,
        s.name as server_name,
        p.name as process_name
      FROM alerts a
      LEFT JOIN servers s ON a.server_id = s.id
      LEFT JOIN processes p ON a.process_id = p.id
      ORDER BY a.created_at DESC
    `);
    return { alerts: rows };
  });

  fastify.post('/api/alerts', { preHandler: [requireAdmin] }, async (request) => {
    const { server_id, process_id, condition_type, threshold_value, channel, target, cooldown_minutes } = request.body || {};
    if (!condition_type || !channel || !target) {
      return { error: 'condition_type, channel, and target are required' };
    }

    const [result] = await pool.execute(
      `INSERT INTO alerts (server_id, process_id, condition_type, threshold_value, channel, target, cooldown_minutes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [server_id || null, process_id || null, condition_type, threshold_value || null, channel, target, cooldown_minutes || 15]
    );
    return { id: result.insertId };
  });

  fastify.patch('/api/alerts/:id', { preHandler: [requireAdmin] }, async (request) => {
    const { enabled, threshold_value, channel, target, cooldown_minutes } = request.body || {};
    const fields = [];
    const values = [];

    if (enabled !== undefined) { fields.push('enabled = ?'); values.push(enabled); }
    if (threshold_value !== undefined) { fields.push('threshold_value = ?'); values.push(threshold_value); }
    if (channel !== undefined) { fields.push('channel = ?'); values.push(channel); }
    if (target !== undefined) { fields.push('target = ?'); values.push(target); }
    if (cooldown_minutes !== undefined) { fields.push('cooldown_minutes = ?'); values.push(cooldown_minutes); }

    if (fields.length === 0) return { error: 'No fields to update' };

    values.push(request.params.id);
    await pool.execute(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`, values);
    return { ok: true };
  });

  fastify.delete('/api/alerts/:id', { preHandler: [requireAdmin] }, async (request) => {
    await pool.execute('DELETE FROM alerts WHERE id = ?', [request.params.id]);
    return { ok: true };
  });

  // Test alert - sends a sample notification to verify the webhook/channel works
  fastify.post('/api/alerts/:id/test', async (request) => {
    const [rows] = await pool.execute('SELECT * FROM alerts WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Alert not found' };

    const alert = rows[0];
    try {
      if (alert.channel === 'discord' || alert.channel === 'webhook') {
        const res = await fetch(alert.target, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'PM2 Monitor',
            embeds: [{
              title: '🧪 Test Alert',
              description: 'This is a test notification from PM2 Monitor. If you can see this, your webhook is working!',
              color: 0x3b82f6,
              timestamp: new Date().toISOString(),
              footer: { text: 'PM2 Monitor' },
            }],
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { error: `Webhook returned ${res.status}: ${text}` };
        }
        return { ok: true, message: 'Test notification sent' };
      }
      return { error: `Test not supported for channel: ${alert.channel}` };
    } catch (err) {
      return { error: err.message };
    }
  });
}
