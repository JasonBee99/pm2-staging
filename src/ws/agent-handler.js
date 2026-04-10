import pool from '../db.js';
import { commandQueue } from '../services/command-queue.js';
import { broadcastToDashboard } from './dashboard-handler.js';

// Connected agents: server_id -> WebSocket
const agentConnections = new Map();

export function getAgentConnection(serverId) {
  return agentConnections.get(serverId);
}

export function sendToAgent(serverId, message) {
  const ws = agentConnections.get(serverId);
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(message));
    return true;
  }
  return false;
}

export default async function agentWsHandler(fastify) {
  fastify.get('/ws/agent', { websocket: true }, (socket, request) => {
    let serverId = null;
    let authenticated = false;

    const timeout = setTimeout(() => {
      if (!authenticated) {
        socket.close(4001, 'Auth timeout');
      }
    }, 10000);

    socket.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      // First message must be auth
      if (!authenticated) {
        if (msg.type !== 'auth' || !msg.token) {
          socket.close(4002, 'First message must be auth');
          return;
        }

        try {
          const [rows] = await pool.execute(
            'SELECT id, name FROM servers WHERE agent_token = ?',
            [msg.token]
          );

          if (rows.length === 0) {
            socket.close(4003, 'Invalid token');
            return;
          }

          serverId = rows[0].id;
          authenticated = true;
          clearTimeout(timeout);

          // Register connection
          const existing = agentConnections.get(serverId);
          if (existing) {
            try { existing.close(4004, 'Replaced by new connection'); } catch {}
          }
          agentConnections.set(serverId, socket);

          // Mark server online
          await pool.execute(
            "UPDATE servers SET status = 'online', last_seen_at = NOW() WHERE id = ?",
            [serverId]
          );

          socket.send(JSON.stringify({ type: 'auth_ok', server_id: serverId }));

          // Send any pending commands
          const pendingCmds = commandQueue.drain(serverId);
          for (const cmd of pendingCmds) {
            socket.send(JSON.stringify({ type: 'command', ...cmd }));
          }

          // Notify dashboard
          broadcastToDashboard({
            type: 'server_status',
            server_id: serverId,
            status: 'online',
          });

          console.log(`[ws] Agent connected: ${rows[0].name} (${serverId})`);
        } catch (err) {
          console.error('[ws] Agent auth error:', err.message);
          socket.close(4005, 'Auth error');
        }
        return;
      }

      // Handle authenticated messages
      try {
        switch (msg.type) {
          case 'heartbeat':
            await pool.execute(
              "UPDATE servers SET status = 'online', last_seen_at = NOW() WHERE id = ?",
              [serverId]
            );
            break;

          case 'metrics':
            if (Array.isArray(msg.data) && msg.data.length > 0) {
              // Also treat metrics arrival as a heartbeat
              await pool.execute(
                "UPDATE servers SET status = 'online', last_seen_at = NOW() WHERE id = ?",
                [serverId]
              );

              const values = [];
              const placeholders = [];
              for (const m of msg.data) {
                placeholders.push('(?, ?, ?, ?)');
                values.push(m.process_id, m.time || new Date().toISOString(), m.cpu_pct || 0, m.mem_bytes || 0);

                // Forward to dashboard in real-time
                broadcastToDashboard({
                  type: 'metrics_tick',
                  process_id: m.process_id,
                  cpu: m.cpu_pct,
                  mem: m.mem_bytes,
                  time: m.time,
                });
              }
              await pool.execute(
                `INSERT INTO metrics (process_id, recorded_at, cpu_pct, mem_bytes) VALUES ${placeholders.join(',')}`,
                values
              );
            }
            break;

          case 'event':
            if (msg.data) {
              const e = msg.data;
              await pool.execute(
                'INSERT INTO events (process_id, occurred_at, kind, exit_code, message) VALUES (?, ?, ?, ?, ?)',
                [e.process_id, e.time || new Date().toISOString(), e.kind, e.exit_code || null, e.message || null]
              );

              // Update process status
              const statusMap = { start: 'running', stop: 'stopped', crash: 'crashed', restart: 'restarting' };
              if (statusMap[e.kind]) {
                const updates = [`status = '${statusMap[e.kind]}'`];
                if (e.kind === 'start') updates.push('uptime_started_at = NOW()');
                if (e.kind === 'restart') updates.push('restart_count = restart_count + 1');
                if (e.pid) updates.push(`pid = ${parseInt(e.pid)}`);
                await pool.execute(`UPDATE processes SET ${updates.join(', ')} WHERE id = ?`, [e.process_id]);
              }

              // Forward to dashboard
              broadcastToDashboard({ type: 'event', ...e, server_id: serverId });

              // Fetch updated process and broadcast
              const [rows] = await pool.execute('SELECT * FROM processes WHERE id = ?', [e.process_id]);
              if (rows.length > 0) {
                broadcastToDashboard({ type: 'process_update', process: rows[0] });
              }
            }
            break;

          case 'log':
            if (msg.data) {
              const l = msg.data;
              await pool.execute(
                'INSERT INTO log_lines (process_id, logged_at, stream, line) VALUES (?, ?, ?, ?)',
                [l.process_id, l.time || new Date().toISOString(), l.stream || 'stdout', l.line || '']
              );

              // Forward to subscribed dashboard clients
              broadcastToDashboard({
                type: 'log_line',
                process_id: l.process_id,
                stream: l.stream,
                line: l.line,
                time: l.time,
              });
            }
            break;

          case 'command_ack':
            broadcastToDashboard({
              type: 'command_ack',
              command_id: msg.command_id,
              success: msg.success,
              message: msg.message,
            });
            break;
        }
      } catch (err) {
        console.error(`[ws] Agent message error (${msg.type}):`, err.message);
      }
    });

    socket.on('close', async () => {
      clearTimeout(timeout);
      if (serverId) {
        agentConnections.delete(serverId);
        try {
          await pool.execute(
            "UPDATE servers SET status = 'offline' WHERE id = ?",
            [serverId]
          );
          broadcastToDashboard({
            type: 'server_status',
            server_id: serverId,
            status: 'offline',
          });
        } catch {}
        console.log(`[ws] Agent disconnected: ${serverId}`);
      }
    });

    socket.on('error', (err) => {
      console.error('[ws] Agent socket error:', err.message);
    });
  });

  // Wire up command queue to send via WS when possible
  commandQueue.setWsSender((serverId, cmd) => {
    sendToAgent(serverId, { type: 'command', ...cmd });
  });
}
