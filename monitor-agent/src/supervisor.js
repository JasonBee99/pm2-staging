import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { getConfig } from './config.js';
import { isProcessAlive, cleanupPid } from './metrics-collector.js';

// Managed processes: process_id -> { config, child, pid, status, restartCount, backoff }
const managed = new Map();

// Event callback - set by index.js
let onEvent = null;
let onLog = null;

export function setEventCallback(fn) { onEvent = fn; }
export function setLogCallback(fn) { onLog = fn; }

export function getManagedProcesses() { return managed; }

/**
 * Apply a new config from central server.
 * Starts new processes, stops removed ones, updates changed ones.
 */
export function applyConfig(processConfigs) {
  const newIds = new Set(processConfigs.map(p => p.id));

  // Stop processes that are no longer in config
  for (const [id, entry] of managed) {
    if (!newIds.has(id)) {
      console.log(`[supervisor] Removing process: ${entry.config.name}`);
      stopProcess(id);
      managed.delete(id);
    }
  }

  // Add or update processes
  for (const pc of processConfigs) {
    const existing = managed.get(pc.id);
    if (!existing) {
      // New process
      managed.set(pc.id, {
        config: pc,
        child: null,
        pid: null,
        status: 'stopped',
        restartCount: 0,
        backoffMs: 1000,
        restartTimer: null,
      });
      console.log(`[supervisor] Added process: ${pc.name}`);
      // Auto-start
      startProcess(pc.id);
    } else {
      // Update config
      existing.config = pc;
    }
  }
}

/**
 * Start a process by id.
 */
export function startProcess(processId) {
  const entry = managed.get(processId);
  if (!entry) return false;

  // Don't start if already running
  if (entry.child && entry.status === 'running') {
    return true;
  }

  const { config: pc } = entry;
  const cfg = getConfig();

  // Parse command into executable + args
  const parts = pc.command.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  // Build environment
  let env = { ...process.env };
  if (pc.env_vars) {
    try {
      const parsed = typeof pc.env_vars === 'string' ? JSON.parse(pc.env_vars) : pc.env_vars;
      env = { ...env, ...parsed };
    } catch {}
  }

  const cwd = pc.cwd || process.cwd();

  // Log file paths
  const stdoutLog = path.join(cfg.log_dir, `${pc.name}-out.log`);
  const stderrLog = path.join(cfg.log_dir, `${pc.name}-err.log`);

  try {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    entry.child = child;
    entry.pid = child.pid;
    entry.status = 'running';

    // Pipe stdout
    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        // Write to log file
        fs.appendFileSync(stdoutLog, `${new Date().toISOString()} ${line}\n`);
        // Send to central
        if (onLog) onLog(processId, 'stdout', line);
      }
    });

    // Pipe stderr
    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        fs.appendFileSync(stderrLog, `${new Date().toISOString()} ${line}\n`);
        if (onLog) onLog(processId, 'stderr', line);
      }
    });

    // Handle exit
    child.on('exit', (code, signal) => {
      const msg = `Process ${pc.name} exited with code ${code}, signal ${signal}`;
      console.log(`[supervisor] ${msg}`);

      entry.child = null;
      entry.pid = null;
      cleanupPid(child.pid);

      if (entry.status === 'stopped') {
        // Was intentionally stopped, don't restart
        if (onEvent) onEvent(processId, 'stop', code, msg);
        return;
      }

      entry.status = 'crashed';
      if (onEvent) onEvent(processId, 'crash', code, msg);

      // Auto-restart with backoff
      if (pc.autorestart !== false && entry.restartCount < (pc.max_restarts || 10)) {
        entry.restartCount++;
        const backoff = Math.min(entry.backoffMs, 30000);
        console.log(`[supervisor] Restarting ${pc.name} in ${backoff}ms (attempt ${entry.restartCount})`);

        entry.restartTimer = setTimeout(() => {
          entry.status = 'restarting';
          if (onEvent) onEvent(processId, 'restart', null, `Restart attempt ${entry.restartCount}`);
          startProcess(processId);
        }, backoff);

        entry.backoffMs = Math.min(backoff * 2, 30000);
      } else if (entry.restartCount >= (pc.max_restarts || 10)) {
        console.log(`[supervisor] ${pc.name} exceeded max restarts (${pc.max_restarts || 10})`);
      }
    });

    child.on('error', (err) => {
      console.error(`[supervisor] Failed to start ${pc.name}:`, err.message);
      entry.child = null;
      entry.pid = null;
      entry.status = 'crashed';
      if (onEvent) onEvent(processId, 'crash', null, `Failed to start: ${err.message}`);
    });

    // Reset backoff on successful start
    entry.backoffMs = 1000;

    console.log(`[supervisor] Started ${pc.name} (PID: ${child.pid})`);
    if (onEvent) onEvent(processId, 'start', null, `Started with PID ${child.pid}`, child.pid);

    return true;
  } catch (err) {
    console.error(`[supervisor] Error starting ${pc.name}:`, err.message);
    entry.status = 'crashed';
    if (onEvent) onEvent(processId, 'crash', null, `Spawn error: ${err.message}`);
    return false;
  }
}

/**
 * Stop a process by id.
 */
export function stopProcess(processId) {
  const entry = managed.get(processId);
  if (!entry) return false;

  // Clear any pending restart timer
  if (entry.restartTimer) {
    clearTimeout(entry.restartTimer);
    entry.restartTimer = null;
  }

  entry.status = 'stopped';
  entry.restartCount = 0;
  entry.backoffMs = 1000;

  if (entry.child) {
    try {
      // Try graceful SIGTERM first
      entry.child.kill('SIGTERM');
      // Force kill after 5 seconds
      setTimeout(() => {
        if (entry.child) {
          try { entry.child.kill('SIGKILL'); } catch {}
        }
      }, 5000);
    } catch {}
  }

  return true;
}

/**
 * Restart a process by id.
 */
export function restartProcess(processId) {
  const entry = managed.get(processId);
  if (!entry) return false;

  entry.restartCount = 0;
  entry.backoffMs = 1000;

  stopProcess(processId);

  // Wait a beat for the old process to die, then start
  setTimeout(() => {
    startProcess(processId);
  }, 1000);

  return true;
}

/**
 * Periodic health check — detect orphaned PIDs.
 */
export function healthCheck() {
  for (const [id, entry] of managed) {
    if (entry.status === 'running' && entry.pid) {
      if (!isProcessAlive(entry.pid)) {
        console.log(`[supervisor] Process ${entry.config.name} (PID ${entry.pid}) no longer alive`);
        entry.child = null;
        entry.pid = null;
        entry.status = 'crashed';
        cleanupPid(entry.pid);
        if (onEvent) onEvent(id, 'crash', null, 'Process disappeared');

        // Auto-restart
        if (entry.config.autorestart !== false && entry.restartCount < (entry.config.max_restarts || 10)) {
          entry.restartCount++;
          setTimeout(() => startProcess(id), entry.backoffMs);
          entry.backoffMs = Math.min(entry.backoffMs * 2, 30000);
        }
      }
    }
  }
}
