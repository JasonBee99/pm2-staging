import cron from 'node-cron';
import pool from '../db.js';

export function startCleanupJobs() {
  // Every hour: aggregate old metrics into hourly buckets
  cron.schedule('0 * * * *', async () => {
    try {
      console.log('[cleanup] Aggregating metrics older than 24h...');

      // Insert hourly aggregates for data between 24h and 7d old that hasn't been aggregated yet
      await pool.execute(`
        INSERT IGNORE INTO metrics_hourly (process_id, hour, avg_cpu, max_cpu, avg_mem, max_mem, sample_count)
        SELECT
          process_id,
          DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00') as hour,
          AVG(cpu_pct),
          MAX(cpu_pct),
          AVG(mem_bytes),
          MAX(mem_bytes),
          COUNT(*)
        FROM metrics
        WHERE recorded_at < NOW() - INTERVAL 24 HOUR
          AND recorded_at >= NOW() - INTERVAL 7 DAY
        GROUP BY process_id, DATE_FORMAT(recorded_at, '%Y-%m-%d %H:00:00')
      `);

      // Delete raw metrics older than 7 days
      const [result] = await pool.execute(
        'DELETE FROM metrics WHERE recorded_at < NOW() - INTERVAL 7 DAY LIMIT 50000'
      );
      if (result.affectedRows > 0) {
        console.log(`[cleanup] Purged ${result.affectedRows} raw metric rows`);
      }
    } catch (err) {
      console.error('[cleanup] Metrics aggregation error:', err.message);
    }
  });

  // Every 6 hours: purge old log lines (keep 48h)
  cron.schedule('0 */6 * * *', async () => {
    try {
      const [result] = await pool.execute(
        'DELETE FROM log_lines WHERE logged_at < NOW() - INTERVAL 48 HOUR LIMIT 100000'
      );
      if (result.affectedRows > 0) {
        console.log(`[cleanup] Purged ${result.affectedRows} log lines`);
      }
    } catch (err) {
      console.error('[cleanup] Log purge error:', err.message);
    }
  });

  // Every day: purge hourly aggregates older than 90 days
  cron.schedule('30 3 * * *', async () => {
    try {
      const [result] = await pool.execute(
        'DELETE FROM metrics_hourly WHERE hour < NOW() - INTERVAL 90 DAY'
      );
      if (result.affectedRows > 0) {
        console.log(`[cleanup] Purged ${result.affectedRows} hourly aggregate rows`);
      }
    } catch (err) {
      console.error('[cleanup] Hourly purge error:', err.message);
    }
  });

  // Every 30 seconds: mark servers as stale/offline
  cron.schedule('*/30 * * * * *', async () => {
    try {
      // Stale if no heartbeat in 60s (agent sends every 10s + metrics every 5s)
      await pool.execute(`
        UPDATE servers SET status = 'stale'
        WHERE status = 'online' AND last_seen_at < NOW() - INTERVAL 60 SECOND
      `);
      // Offline if no heartbeat in 3 minutes
      await pool.execute(`
        UPDATE servers SET status = 'offline'
        WHERE status IN ('stale', 'online') AND last_seen_at < NOW() - INTERVAL 3 MINUTE
      `);
    } catch (err) {
      // Silently ignore
    }
  });

  // Clean expired sessions daily
  cron.schedule('0 4 * * *', async () => {
    try {
      await pool.execute('DELETE FROM sessions WHERE expires < UNIX_TIMESTAMP()');
    } catch (err) {
      console.error('[cleanup] Session purge error:', err.message);
    }
  });

  console.log('✓ Cleanup jobs scheduled');
}
