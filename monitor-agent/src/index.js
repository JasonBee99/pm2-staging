import { loadConfig, getConfig } from './config.js';
import { getProcessMetrics, getSystemInfo } from './metrics-collector.js';
import { collectSystemMetrics } from './system-metrics.js';
import { runDeploy } from './deploy-runner.js';
import {
  applyConfig, startProcess, stopProcess, restartProcess,
  getManagedProcesses, healthCheck, setEventCallback, setLogCallback,
} from './supervisor.js';
import { ExternalMonitor } from './external-monitor.js';
import {
  connect, setCallbacks, sendMetrics, sendEvent, sendLog,
  sendHeartbeat, isConnected, disconnect,
} from './ws-client.js';

// Load config
const config = loadConfig();

// External process monitor (for PM2-managed or other external processes)
const externalMonitor = new ExternalMonitor();

console.log(`
╔══════════════════════════════════════╗
║       Process Monitor Agent          ║
║  Server: ${config.server_name.padEnd(27)}║
╚══════════════════════════════════════╝
`);

// Wire up supervisor callbacks (only for agent-managed processes)
setEventCallback((processId, kind, exitCode, message, pid) => {
  sendEvent(processId, kind, exitCode, message, pid);
});

setLogCallback((processId, stream, line) => {
  sendLog(processId, stream, line);
});

// Apply config, splitting between agent-managed and external
function applyFullConfig(processes) {
  const agentManaged = processes.filter(p => p.managed_by !== 'external');
  const external = processes.filter(p => p.managed_by === 'external');

  console.log(`[agent] Config: ${agentManaged.length} managed, ${external.length} external`);
  applyConfig(agentManaged);
  externalMonitor.updateConfig(external);
}

// Wire up WS callbacks
setCallbacks({
  onAuth: async (serverId) => {
    console.log(`[agent] Registered as server ${serverId}`);

    // Fetch initial config via REST
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
        applyFullConfig(data.processes);
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
      case 'deploy':
        handleDeploy(msg);
        return true;
      case 'config_update':
        fetchConfig();
        return true;
      default:
        console.log(`[agent] Unknown command: ${msg.action || msg.type}`);
        return false;
    }
  },
});

// Handle deploy command from central
async function handleDeploy(msg) {
  const { process_id, command_id, cwd, build_command, env_vars } = msg;

  // Send start event
  const { send } = await import('./ws-client.js');
  send({
    type: 'deploy_start',
    command_id,
    process_id,
    time: new Date().toISOString(),
  });

  // Parse env vars
  let env = {};
  if (env_vars) {
    try {
      env = typeof env_vars === 'string' ? JSON.parse(env_vars) : env_vars;
    } catch {}
  }

  await runDeploy({
    cwd,
    buildCommand: build_command,
    env,
    onOutput: (stream, line) => {
      send({
        type: 'deploy_output',
        command_id,
        process_id,
        stream,
        line,
        time: new Date().toISOString(),
      });
    },
    onDone: async (result) => {
      send({
        type: 'deploy_done',
        command_id,
        process_id,
        success: result.success,
        stage: result.stage || null,
        exit_code: result.exitCode || 0,
        time: new Date().toISOString(),
      });

      // If deploy succeeded, restart the process
      if (result.success) {
        send({
          type: 'deploy_output',
          command_id,
          process_id,
          stream: 'stdout',
          line: '\n━━━ Restarting process ━━━',
          time: new Date().toISOString(),
        });
        const ok = await restartProcess(process_id);
        send({
          type: 'deploy_output',
          command_id,
          process_id,
          stream: ok ? 'stdout' : 'stderr',
          line: ok ? '✓ Process restarted' : '✗ Restart failed',
          time: new Date().toISOString(),
        });
      }
    },
  });
}

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
      applyFullConfig(data.processes);
    }
  } catch (err) {
    console.error('[agent] Failed to fetch config:', err.message);
  }
}

// Connect to central
connect();

// Metrics collection loop
setInterval(() => {
  const batch = [];

  // Agent-managed processes
  const managed = getManagedProcesses();
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

  // External processes (PM2, etc.)
  const ext = externalMonitor.collect();
  batch.push(...ext.metrics);

  // Send external logs
  for (const log of ext.logs) {
    sendLog(log.process_id, log.stream, log.line);
  }

  // Send external events
  for (const evt of ext.events) {
    sendEvent(evt.process_id, evt.kind, evt.exit_code, evt.message, evt.pid);
  }

  if (batch.length > 0) {
    sendMetrics(batch);
  }
}, config.metrics_interval_ms);

// Heartbeat loop — also sends system-level metrics
setInterval(async () => {
  try {
    const sysMetrics = await collectSystemMetrics();
    sendHeartbeat(sysMetrics);
  } catch (err) {
    sendHeartbeat();
  }
}, config.heartbeat_interval_ms);

// Health check loop (detect zombie processes)
setInterval(() => {
  healthCheck();
}, 15000);

// Graceful shutdown — only stop agent-managed processes, leave external ones alone
function shutdown(signal) {
  console.log(`\n[agent] Received ${signal}, shutting down...`);

  const managed = getManagedProcesses();
  for (const [id] of managed) {
    stopProcess(id);
  }

  disconnect();

  setTimeout(() => {
    console.log('[agent] Exiting.');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

console.log('[agent] Running. Press Ctrl+C to stop.');
