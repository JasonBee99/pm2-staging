import { loadConfig, getConfig } from './config.js';
import { getProcessMetrics, getSystemInfo } from './metrics-collector.js';
import {
  applyConfig, startProcess, stopProcess, restartProcess,
  getManagedProcesses, healthCheck, setEventCallback, setLogCallback,
} from './supervisor.js';
import {
  connect, setCallbacks, sendMetrics, sendEvent, sendLog,
  sendHeartbeat, isConnected, disconnect,
} from './ws-client.js';

// Load config
const config = loadConfig();

console.log(`
╔══════════════════════════════════════╗
║       Process Monitor Agent          ║
║  Server: ${config.server_name.padEnd(27)}║
╚══════════════════════════════════════╝
`);

// Wire up supervisor callbacks
setEventCallback((processId, kind, exitCode, message, pid) => {
  sendEvent(processId, kind, exitCode, message, pid);
});

setLogCallback((processId, stream, line) => {
  sendLog(processId, stream, line);
});

// Wire up WS callbacks
setCallbacks({
  onAuth: async (serverId) => {
    console.log(`[agent] Registered as server ${serverId}`);

    // Fetch initial config via REST as backup
    try {
      const url = config.central_url.replace(/\/$/, '');
      const httpUrl = url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
      const res = await fetch(`${httpUrl}/api/agent/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.agent_token}`,
        },
        body: JSON.stringify(getSystemInfo()),
      });
      const data = await res.json();
      if (data.processes) {
        console.log(`[agent] Received ${data.processes.length} process configs`);
        applyConfig(data.processes);
      }
    } catch (err) {
      console.error('[agent] Failed to register via REST:', err.message);
    }
  },

  onCmd: (msg) => {
    switch (msg.action || msg.type) {
      case 'start':
        return startProcess(msg.process_id);
      case 'stop':
        return stopProcess(msg.process_id);
      case 'restart':
        return restartProcess(msg.process_id);
      case 'config_update':
        // Re-fetch config from central
        fetchConfig();
        return true;
      default:
        console.log(`[agent] Unknown command: ${msg.action || msg.type}`);
        return false;
    }
  },
});

// Fetch config from central server
async function fetchConfig() {
  try {
    const url = config.central_url.replace(/\/$/, '');
    const httpUrl = url.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://');
    const res = await fetch(`${httpUrl}/api/agent/config`, {
      headers: { 'Authorization': `Bearer ${config.agent_token}` },
    });
    const data = await res.json();
    if (data.processes) {
      console.log(`[agent] Config update: ${data.processes.length} processes`);
      applyConfig(data.processes);
    }
  } catch (err) {
    console.error('[agent] Failed to fetch config:', err.message);
  }
}

// Connect to central
connect();

// Metrics collection loop
setInterval(() => {
  const managed = getManagedProcesses();
  const batch = [];

  for (const [id, entry] of managed) {
    if (entry.pid && entry.status === 'running') {
      const metrics = getProcessMetrics(entry.pid);
      if (metrics) {
        batch.push({
          process_id: id,
          cpu_pct: metrics.cpu_pct,
          mem_bytes: metrics.mem_bytes,
          time: new Date().toISOString(),
        });
      }
    }
  }

  if (batch.length > 0) {
    sendMetrics(batch);
  }
}, config.metrics_interval_ms);

// Heartbeat loop
setInterval(() => {
  sendHeartbeat();
}, config.heartbeat_interval_ms);

// Health check loop (detect zombie processes)
setInterval(() => {
  healthCheck();
}, 15000);

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n[agent] Received ${signal}, shutting down...`);

  const managed = getManagedProcesses();
  for (const [id] of managed) {
    stopProcess(id);
  }

  disconnect();

  // Give processes 5 seconds to die
  setTimeout(() => {
    console.log('[agent] Exiting.');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[agent] Running. Press Ctrl+C to stop.');
