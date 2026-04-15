import pool from '../db.js';
import { requireAuth } from '../middleware/session-auth.js';

export default async function metricsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // Get metrics for a process
  fastify.get('/api/processes/:id/metrics', async (request) => {
    const range = request.query.range || '1h';
    const rangeMap = {
      '15m': 'INTERVAL 15 MINUTE',
      '1h': 'INTERVAL 1 HOUR',
      '6h': 'INTERVAL 6 HOUR',
      '24h': 'INTERVAL 24 HOUR',
      '7d': 'INTERVAL 7 DAY',
      '30d': 'INTERVAL 30 DAY',
    };

    const interval = rangeMap[range] || rangeMap['1h'];

    // For short ranges, use raw metrics. For longer ranges, use hourly aggregates.
    if (['15m', '1h', '6h', '24h'].includes(range)) {
      const [rows] = await pool.execute(
        `SELECT recorded_at as time, cpu_pct as cpu, mem_bytes as mem
         FROM metrics
         WHERE process_id = ? AND recorded_at >= NOW() - ${interval}
         ORDER BY recorded_at DESC LIMIT 2000`,
        [request.params.id]
      );
      return { metrics: rows, range };
    } else {
      const [rows] = await pool.execute(
        `SELECT hour as time, avg_cpu as cpu, max_cpu, avg_mem as mem, max_mem, sample_count
         FROM metrics_hourly
         WHERE process_id = ? AND hour >= NOW() - ${interval}
         ORDER BY hour`,
        [request.params.id]
      );
      return { metrics: rows, range, aggregated: true };
    }
  });

  // Get logs for a process
  fastify.get('/api/processes/:id/logs', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '200'), 1000);
    const stream = request.query.stream; // 'stdout', 'stderr', or undefined for all

    let query = 'SELECT logged_at as time, stream, line FROM log_lines WHERE process_id = ?';
    const params = [request.params.id];

    if (stream && ['stdout', 'stderr'].includes(stream)) {
      query += ' AND stream = ?';
      params.push(stream);
    }

    query += ' ORDER BY logged_at DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.execute(query, params);
    return { logs: rows.reverse() }; // Return chronological order
  });

  // Get events for a process
  fastify.get('/api/processes/:id/events', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '50'), 200);
    const [rows] = await pool.execute(
      'SELECT * FROM events WHERE process_id = ? ORDER BY occurred_at DESC LIMIT ?',
      [request.params.id, limit]
    );
    return { events: rows };
  });

  // Overview metrics for dashboard home — latest CPU/mem per process on a server
  fastify.get('/api/servers/:id/metrics/latest', async (request) => {
    const [rows] = await pool.execute(
      `SELECT p.id as process_id, p.name,
        (SELECT cpu_pct FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as cpu,
        (SELECT mem_bytes FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as mem
       FROM processes p WHERE p.server_id = ?`,
      [request.params.id]
    );
    return { metrics: rows };
  });
}
