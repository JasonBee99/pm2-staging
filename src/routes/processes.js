import { v4 as uuidv4 } from 'uuid';
import pool from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/session-auth.js';
import { commandQueue } from '../services/command-queue.js';
import { broadcastToDashboard } from '../ws/dashboard-handler.js';

export default async function processRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // List processes for a server
  fastify.get('/api/servers/:id/processes', async (request) => {
    const [rows] = await pool.execute(
      `SELECT p.*,
        (SELECT cpu_pct FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as latest_cpu,
        (SELECT mem_bytes FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as latest_mem
       FROM processes p WHERE p.server_id = ? ORDER BY p.name`,
      [request.params.id]
    );
    return { processes: rows };
  });

  // Create new process
  fastify.post('/api/servers/:id/processes', { preHandler: [requireAdmin] }, async (request) => {
    const { name, command, cwd, env_vars, autorestart, max_restarts, managed_by, match_pattern, build_command } = request.body || {};
    if (!name || !command) {
      return { error: 'name and command are required' };
    }

    const id = uuidv4();
    await pool.execute(
      `INSERT INTO processes (id, server_id, name, command, cwd, env_vars, autorestart, max_restarts, managed_by, match_pattern, build_command)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        request.params.id,
        name,
        command,
        cwd || null,
        env_vars ? JSON.stringify(env_vars) : null,
        autorestart !== false,
        max_restarts || 10,
        managed_by || 'agent',
        match_pattern || null,
        build_command || null,
      ]
    );

    // Notify agent of config change
    commandQueue.push(request.params.id, { action: 'config_update' });

    const [rows] = await pool.execute('SELECT * FROM processes WHERE id = ?', [id]);
    return { process: rows[0] };
  });

  // Edit process config
  fastify.patch('/api/processes/:id', { preHandler: [requireAdmin] }, async (request) => {
    const { name, command, cwd, env_vars, autorestart, max_restarts, managed_by, match_pattern, build_command } = request.body || {};
    const fields = [];
    const values = [];

    if (name !== undefined) { fields.push('name = ?'); values.push(name); }
    if (command !== undefined) { fields.push('command = ?'); values.push(command); }
    if (cwd !== undefined) { fields.push('cwd = ?'); values.push(cwd); }
    if (env_vars !== undefined) { fields.push('env_vars = ?'); values.push(JSON.stringify(env_vars)); }
    if (autorestart !== undefined) { fields.push('autorestart = ?'); values.push(autorestart); }
    if (max_restarts !== undefined) { fields.push('max_restarts = ?'); values.push(max_restarts); }
    if (managed_by !== undefined) { fields.push('managed_by = ?'); values.push(managed_by); }
    if (match_pattern !== undefined) { fields.push('match_pattern = ?'); values.push(match_pattern); }
    if (build_command !== undefined) { fields.push('build_command = ?'); values.push(build_command); }

    if (fields.length === 0) return { error: 'No fields to update' };

    values.push(request.params.id);
    await pool.execute(`UPDATE processes SET ${fields.join(', ')} WHERE id = ?`, values);

    // Get server_id to notify agent
    const [rows] = await pool.execute('SELECT * FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length > 0) {
      commandQueue.push(rows[0].server_id, { action: 'config_update' });
    }

    return { process: rows[0] };
  });

  // Delete process
  fastify.delete('/api/processes/:id', { preHandler: [requireAdmin] }, async (request) => {
    const [rows] = await pool.execute('SELECT server_id FROM processes WHERE id = ?', [request.params.id]);
    await pool.execute('DELETE FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length > 0) {
      commandQueue.push(rows[0].server_id, { action: 'config_update' });
    }
    return { ok: true };
  });

  // Start process
  fastify.post('/api/processes/:id/start', async (request) => {
    const [rows] = await pool.execute('SELECT server_id FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Process not found' };
    commandQueue.push(rows[0].server_id, {
      action: 'start',
      process_id: request.params.id,
    });
    return { ok: true, message: 'Start command queued' };
  });

  // Stop process
  fastify.post('/api/processes/:id/stop', async (request) => {
    const [rows] = await pool.execute('SELECT server_id FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Process not found' };
    commandQueue.push(rows[0].server_id, {
      action: 'stop',
      process_id: request.params.id,
    });
    return { ok: true, message: 'Stop command queued' };
  });

  // Restart process
  fastify.post('/api/processes/:id/restart', async (request) => {
    const [rows] = await pool.execute('SELECT server_id FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Process not found' };
    commandQueue.push(rows[0].server_id, {
      action: 'restart',
      process_id: request.params.id,
    });
    return { ok: true, message: 'Restart command queued' };
  });

  // Deploy: run git pull + build, then restart
  fastify.post('/api/processes/:id/deploy', async (request) => {
    const [rows] = await pool.execute('SELECT * FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Process not found' };
    const proc = rows[0];

    if (!proc.cwd) {
      return { error: 'Process has no working directory configured' };
    }

    const cmd = commandQueue.push(proc.server_id, {
      action: 'deploy',
      process_id: proc.id,
      cwd: proc.cwd,
      build_command: proc.build_command || 'npm run build',
      env_vars: proc.env_vars,
    });

    return { ok: true, command_id: cmd.id, message: 'Deploy command queued' };
  });

  // Get process detail
  fastify.get('/api/processes/:id', async (request) => {
    const [rows] = await pool.execute('SELECT * FROM processes WHERE id = ?', [request.params.id]);
    if (rows.length === 0) return { error: 'Not found' };
    return { process: rows[0] };
  });
}
