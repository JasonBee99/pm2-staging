import WebSocket from 'ws';
import { getConfig } from './config.js';

let ws = null;
let authenticated = false;
let serverId = null;
let reconnectTimer = null;
let messageQueue = []; // Buffer messages while disconnected

// Callbacks
let onAuthenticated = null;
let onCommand = null;

export function setCallbacks({ onAuth, onCmd }) {
  onAuthenticated = onAuth;
  onCommand = onCmd;
}

export function isConnected() {
  return ws && ws.readyState === WebSocket.OPEN && authenticated;
}

export function getServerId() { return serverId; }

export function connect() {
  const config = getConfig();

  // Build WS URL
  let wsUrl = config.central_url;
  // Ensure it ends with /ws/agent
  if (!wsUrl.endsWith('/ws/agent')) {
    wsUrl = wsUrl.replace(/\/$/, '') + '/ws/agent';
  }
  // Convert https:// to wss:// if needed
  wsUrl = wsUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

  console.log(`[ws] Connecting to ${wsUrl}...`);

  try {
    ws = new WebSocket(wsUrl, {
      headers: {},
      handshakeTimeout: 10000,
    });
  } catch (err) {
    console.error('[ws] Connection error:', err.message);
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    console.log('[ws] Connected, authenticating...');
    ws.send(JSON.stringify({
      type: 'auth',
      token: config.agent_token,
    }));
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'auth_ok') {
      authenticated = true;
      serverId = msg.server_id;
      console.log(`[ws] Authenticated. Server ID: ${serverId}`);

      // Flush queued messages
      for (const queued of messageQueue) {
        safeSend(queued);
      }
      messageQueue = [];

      if (onAuthenticated) onAuthenticated(serverId);
      return;
    }

    if (msg.type === 'command') {
      console.log(`[ws] Received command: ${msg.action} for process ${msg.process_id || 'all'}`);
      if (onCommand) {
        const result = onCommand(msg);
        // Acknowledge
        safeSend({
          type: 'command_ack',
          command_id: msg.id,
          success: result !== false,
          message: result === false ? 'Command failed' : 'OK',
        });
      }
    }

    if (msg.type === 'config_update') {
      console.log('[ws] Received config update');
      if (onCommand) onCommand(msg);
    }

    if (msg.type === 'tail_logs') {
      if (onCommand) onCommand(msg);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`[ws] Disconnected (code: ${code})`);
    authenticated = false;
    ws = null;
    scheduleReconnect();
  });

  ws.on('error', (err) => {
    console.error('[ws] Error:', err.message);
  });
}

function scheduleReconnect() {
  const config = getConfig();
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, config.reconnect_interval_ms || 5000);
}

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

/**
 * Send a message, buffering if disconnected.
 */
export function send(data) {
  if (!safeSend(data)) {
    // Buffer up to 500 messages
    if (messageQueue.length < 500) {
      messageQueue.push(data);
    }
  }
}

/**
 * Send metrics batch.
 */
export function sendMetrics(metricsArray) {
  send({ type: 'metrics', data: metricsArray });
}

/**
 * Send a lifecycle event.
 */
export function sendEvent(processId, kind, exitCode, message, pid) {
  send({
    type: 'event',
    data: {
      process_id: processId,
      kind,
      exit_code: exitCode,
      message,
      pid,
      time: new Date().toISOString(),
    },
  });
}

/**
 * Send a log line.
 */
export function sendLog(processId, stream, line) {
  send({
    type: 'log',
    data: {
      process_id: processId,
      stream,
      line,
      time: new Date().toISOString(),
    },
  });
}

/**
 * Send heartbeat with optional system metrics.
 */
export function sendHeartbeat(sysMetrics) {
  send({
    type: 'heartbeat',
    data: {
      uptime: process.uptime(),
      system: sysMetrics || null,
    },
  });
}

export function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }
}
