import cron from 'node-cron';
import pool from '../db.js';

// Color codes for Discord embeds
const COLORS = {
  crash: 0xef4444,      // red
  offline: 0xef4444,    // red
  restart_loop: 0xf97316, // orange
  cpu_above: 0xeab308,  // yellow
  mem_above: 0xeab308,  // yellow
};

const CONDITION_LABELS = {
  crash: 'Process Crash',
  restart_loop: 'Restart Loop',
  offline: 'Server Offline',
  cpu_above: 'High CPU',
  mem_above: 'High Memory',
};

/**
 * Send a notification via the configured channel.
 */
async function sendNotification(alert, context) {
  const { channel, target } = alert;

  try {
    if (channel === 'discord' || channel === 'webhook') {
      await sendDiscordWebhook(target, alert, context);
    } else if (channel === 'email') {
      // Email not implemented yet — log instead
      console.log(`[alerts] Email alert (not yet implemented): ${context.title}`);
    }
  } catch (err) {
    console.error(`[alerts] Failed to send notification:`, err.message);
  }
}

/**
 * Send a Discord webhook message.
 */
async function sendDiscordWebhook(url, alert, context) {
  const color = COLORS[alert.condition_type] || 0x3b82f6;

  const embed = {
    title: context.title,
    description: context.description,
    color,
    timestamp: new Date().toISOString(),
    fields: context.fields || [],
    footer: { text: 'PM2 Monitor' },
  };

  const payload = {
    username: 'PM2 Monitor',
    embeds: [embed],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord webhook ${res.status}: ${text}`);
  }
}

/**
 * Check if an alert is in cooldown period.
 */
function isInCooldown(alert) {
  if (!alert.last_triggered_at) return false;
  const lastMs = new Date(alert.last_triggered_at).getTime();
  const cooldownMs = (alert.cooldown_minutes || 15) * 60 * 1000;
  return Date.now() - lastMs < cooldownMs;
}

/**
 * Mark an alert as triggered (updates last_triggered_at).
 */
async function markTriggered(alertId) {
  await pool.execute(
    'UPDATE alerts SET last_triggered_at = NOW() WHERE id = ?',
    [alertId]
  );
}

/**
 * Fetch all enabled alerts that match a given process/server scope.
 * An alert matches if:
 * - It has no process_id and no server_id (global)
 * - It has a matching server_id and no process_id (server-wide)
 * - It has a matching process_id
 */
async function findMatchingAlerts(conditionType, serverId, processId) {
  const [rows] = await pool.execute(`
    SELECT * FROM alerts
    WHERE enabled = TRUE
      AND condition_type = ?
      AND (
        (process_id = ?)
        OR (process_id IS NULL AND server_id = ?)
        OR (process_id IS NULL AND server_id IS NULL)
      )
  `, [conditionType, processId, serverId]);
  return rows;
}

/**
 * Trigger an alert: checks cooldown, marks triggered, sends notification.
 */
async function triggerAlert(alert, context) {
  if (isInCooldown(alert)) return;

  await markTriggered(alert.id);
  console.log(`[alerts] Triggering: ${alert.condition_type} → ${alert.channel} (${context.title})`);
  await sendNotification(alert, context);
}

/**
 * Called when a crash event arrives from an agent.
 */
export async function handleCrashEvent(processId, serverId, message) {
  const [processRows] = await pool.execute(
    'SELECT p.name, s.name as server_name FROM processes p JOIN servers s ON p.server_id = s.id WHERE p.id = ?',
    [processId]
  );
  if (processRows.length === 0) return;

  const p = processRows[0];
  const alerts = await findMatchingAlerts('crash', serverId, processId);

  for (const alert of alerts) {
    await triggerAlert(alert, {
      title: `💥 Process Crashed: ${p.name}`,
      description: `**Server:** ${p.server_name}\n**Process:** ${p.name}\n\n${message || 'Process exited unexpectedly'}`,
      fields: [],
    });
  }
}

/**
 * Called when a restart loop is detected.
 */
export async function handleRestartLoop(processId, serverId, restartCount) {
  const [processRows] = await pool.execute(
    'SELECT p.name, s.name as server_name FROM processes p JOIN servers s ON p.server_id = s.id WHERE p.id = ?',
    [processId]
  );
  if (processRows.length === 0) return;

  const p = processRows[0];
  const alerts = await findMatchingAlerts('restart_loop', serverId, processId);

  for (const alert of alerts) {
    await triggerAlert(alert, {
      title: `🔁 Restart Loop: ${p.name}`,
      description: `**Server:** ${p.server_name}\n**Process:** ${p.name}\n\nRestarted ${restartCount} times.`,
      fields: [],
    });
  }
}

/**
 * Periodic check for threshold-based alerts (CPU, memory) and offline servers.
 */
async function runPeriodicChecks() {
  try {
    // Check CPU and memory thresholds
    const [activeAlerts] = await pool.execute(`
      SELECT * FROM alerts
      WHERE enabled = TRUE
        AND condition_type IN ('cpu_above', 'mem_above')
    `);

    for (const alert of activeAlerts) {
      if (isInCooldown(alert)) continue;

      // Find processes in scope
      let processFilter = '';
      const params = [];
      if (alert.process_id) {
        processFilter = 'WHERE p.id = ?';
        params.push(alert.process_id);
      } else if (alert.server_id) {
        processFilter = 'WHERE p.server_id = ?';
        params.push(alert.server_id);
      }

      // Get latest metric for each process in scope
      const [processes] = await pool.execute(`
        SELECT p.id, p.name, p.server_id, s.name as server_name,
          (SELECT cpu_pct FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as cpu,
          (SELECT mem_bytes FROM metrics m WHERE m.process_id = p.id ORDER BY recorded_at DESC LIMIT 1) as mem
        FROM processes p
        JOIN servers s ON p.server_id = s.id
        ${processFilter}
      `, params);

      for (const p of processes) {
        let violated = false;
        let valueStr = '';
        let thresholdStr = '';

        if (alert.condition_type === 'cpu_above' && p.cpu != null) {
          if (p.cpu >= alert.threshold_value) {
            violated = true;
            valueStr = `${p.cpu.toFixed(1)}%`;
            thresholdStr = `${alert.threshold_value}%`;
          }
        } else if (alert.condition_type === 'mem_above' && p.mem != null) {
          // threshold_value is stored in MB
          const memMb = p.mem / (1024 * 1024);
          if (memMb >= alert.threshold_value) {
            violated = true;
            valueStr = `${memMb.toFixed(0)} MB`;
            thresholdStr = `${alert.threshold_value} MB`;
          }
        }

        if (violated) {
          const icon = alert.condition_type === 'cpu_above' ? '🔥' : '📈';
          await triggerAlert(alert, {
            title: `${icon} ${CONDITION_LABELS[alert.condition_type]}: ${p.name}`,
            description: `**Server:** ${p.server_name}\n**Process:** ${p.name}`,
            fields: [
              { name: 'Current', value: valueStr, inline: true },
              { name: 'Threshold', value: thresholdStr, inline: true },
            ],
          });
          break; // Only trigger once per alert per check
        }
      }
    }

    // Check for offline servers
    const [offlineAlerts] = await pool.execute(`
      SELECT * FROM alerts
      WHERE enabled = TRUE AND condition_type = 'offline'
    `);

    for (const alert of offlineAlerts) {
      if (isInCooldown(alert)) continue;

      let serverFilter = '';
      const params = [];
      if (alert.server_id) {
        serverFilter = 'WHERE id = ? AND status = "offline"';
        params.push(alert.server_id);
      } else {
        serverFilter = 'WHERE status = "offline"';
      }

      const [servers] = await pool.execute(`SELECT id, name, last_seen_at FROM servers ${serverFilter}`, params);

      for (const srv of servers) {
        await triggerAlert(alert, {
          title: `🔴 Server Offline: ${srv.name}`,
          description: `Server **${srv.name}** has not checked in.\n\nLast seen: ${srv.last_seen_at || 'never'}`,
          fields: [],
        });
        break; // Only trigger once per alert per check
      }
    }
  } catch (err) {
    console.error('[alerts] Periodic check error:', err.message);
  }
}

/**
 * Start the alert engine.
 */
export function startAlertEngine() {
  // Run checks every 30 seconds
  cron.schedule('*/30 * * * * *', runPeriodicChecks);
  console.log('✓ Alert engine started');
}
