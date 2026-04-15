import os from 'os';
import pool from '../db.js';
import { requireAgentToken } from '../middleware/agent-token-auth.js';
import { commandQueue } from '../services/command-queue.js';

export default async function agentRoutes(fastify) {
  // All agent routes require token auth
  fastify.addHook('preHandler', requireAgentToken);

  // Register / handshake
  fastify.post('/api/agent/register', async (request) => {
    const { hostname, os_info, agent_version, ip_address } = request.body || {};
    const serverId = request.server_id;

    await pool.execute(
      `UPDATE servers SET hostname = ?, os_info = ?, agent_version = ?, ip_address = ?,
       status = 'online', last_seen_at = NOW() WHERE id = ?`,
      [hostname || '', os_info || '', agent_version || '1.0.0', ip_address || '', serverId]
    );

    // Return current process config
    const [processes] = await pool.execute(
      'SELECT id, name, command, cwd, env_vars, autorestart, max_restarts, managed_by, match_pattern, build_command FROM processes WHERE server_id = ?',
      [serverId]
    );

    return { server_id: serverId, processes };
  });

  // Fetch config (desired process list)
  fastify.get('/api/agent/config', async (request) => {
    const [processes] = await pool.execute(
      'SELECT id, name, command, cwd, env_vars, autorestart, max_restarts, managed_by, match_pattern, build_command FROM processes WHERE server_id = ?',
      [request.server_id]
    );
    return { processes };
  });

  // Heartbeat
  fastify.post('/api/agent/heartbeat', async (request) => {
    await pool.execute(
      "UPDATE servers SET status = 'online', last_seen_at = NOW() WHERE id = ?",
      [request.server_id]
    );

    // Return any pending commands
    const commands = commandQueue.drain(request.server_id);
    return { commands };
  });

  // Batch metrics push
  fastify.post('/api/agent/metrics', async (request) => {
    const items = request.body || [];
    if (!Array.isArray(items) || items.length === 0) return { ok: true };

    const values = [];
    const placeholders = [];
    for (const m of items) {
      placeholders.push('(?, ?, ?, ?)');
      values.push(m.process_id, m.time || new Date().toISOString(), m.cpu_pct || 0, m.mem_bytes || 0);
    }

    await pool.execute(
      `INSERT INTO metrics (process_id, recorded_at, cpu_pct, mem_bytes) VALUES ${placeholders.join(',')}`,
      values
    );
    return { ok: true, count: items.length };
  });

  // Batch events push
  fastify.post('/api/agent/events', async (request) => {
    const items = request.body || [];
    if (!Array.isArray(items) || items.length === 0) return { ok: true };

    for (const e of items) {
      await pool.execute(
        'INSERT INTO events (process_id, occurred_at, kind, exit_code, message) VALUES (?, ?, ?, ?, ?)',
        [e.process_id, e.time || new Date().toISOString(), e.kind, e.exit_code || null, e.message || null]
      );

      // Update process status based on event
      const statusMap = { start: 'running', stop: 'stopped', crash: 'crashed', restart: 'restarting' };
      if (statusMap[e.kind]) {
        const updates = [`status = '${statusMap[e.kind]}'`];
        if (e.kind === 'start') updates.push('uptime_started_at = NOW()');
        if (e.kind === 'restart') updates.push('restart_count = restart_count + 1');
        if (e.pid) updates.push(`pid = ${parseInt(e.pid)}`);
        await pool.execute(
          `UPDATE processes SET ${updates.join(', ')} WHERE id = ?`,
          [e.process_id]
        );
      }
    }
    return { ok: true };
  });

  // Batch log lines push
  fastify.post('/api/agent/logs', async (request) => {
    const items = request.body || [];
    if (!Array.isArray(items) || items.length === 0) return { ok: true };

    const values = [];
    const placeholders = [];
    for (const l of items) {
      placeholders.push('(?, ?, ?, ?)');
      values.push(l.process_id, l.time || new Date().toISOString(), l.stream || 'stdout', l.line || '');
    }

    await pool.execute(
      `INSERT INTO log_lines (process_id, logged_at, stream, line) VALUES ${placeholders.join(',')}`,
      values
    );
    return { ok: true };
  });
}
