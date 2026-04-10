import fs from 'fs';
import path from 'path';
import os from 'os';
import { getProcessMetrics } from './metrics-collector.js';

/**
 * Find a PID by matching a pattern against proc cmdlines
 */
export function findPidByPattern(pattern) {
  try {
    const procDirs = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));

    for (const pid of procDirs) {
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
          .replace(/\0/g, ' ')
          .trim();

        if (cmdline && cmdline.includes(pattern)) {
          // Don't match our own agent process
          if (parseInt(pid) === process.pid) continue;
          return parseInt(pid);
        }
      } catch {
        // Process may have exited between readdir and readFile
      }
    }
  } catch (err) {
    console.error('[external] Error scanning /proc:', err.message);
  }
  return null;
}

/**
 * Tail a log file, returning new lines since last read.
 */
class LogTailer {
  constructor(filePath, stream) {
    this.filePath = filePath;
    this.stream = stream;
    this.lastSize = 0;
    this.lastInode = null;

    // Initialize to end of file so we don't replay history
    try {
      const stat = fs.statSync(filePath);
      this.lastSize = stat.size;
      this.lastInode = stat.ino;
    } catch {
      // File doesn't exist yet, that's fine
    }
  }

  readNewLines() {
    const lines = [];
    try {
      const stat = fs.statSync(this.filePath);

      // Check if file was rotated (inode changed or size shrank)
      if (stat.ino !== this.lastInode || stat.size < this.lastSize) {
        this.lastSize = 0;
        this.lastInode = stat.ino;
      }

      if (stat.size > this.lastSize) {
        const fd = fs.openSync(this.filePath, 'r');
        const bufSize = Math.min(stat.size - this.lastSize, 64 * 1024); // Max 64KB per read
        const buf = Buffer.alloc(bufSize);
        fs.readSync(fd, buf, 0, bufSize, this.lastSize);
        fs.closeSync(fd);

        const text = buf.toString('utf8');
        const newLines = text.split('\n').filter(l => l.length > 0);

        for (const line of newLines) {
          lines.push({ stream: this.stream, line });
        }

        this.lastSize = stat.size;
      }
    } catch {
      // File may not exist or be inaccessible
    }
    return lines;
  }
}

/**
 * Manages monitoring of external (non-agent-managed) processes.
 */
export class ExternalMonitor {
  constructor() {
    this.watched = new Map(); // process_id -> { config, pid, tailers }
  }

  /**
   * Update the set of external processes to monitor.
   */
  updateConfig(processConfigs) {
    const newIds = new Set(processConfigs.map(p => p.id));

    // Remove processes no longer in config
    for (const [id] of this.watched) {
      if (!newIds.has(id)) {
        this.watched.delete(id);
      }
    }

    // Add or update processes
    for (const pc of processConfigs) {
      if (pc.managed_by !== 'external') continue;

      const existing = this.watched.get(pc.id);
      if (!existing) {
        const homeDir = os.homedir();
        // Default PM2 log paths
        const outLog = path.join(homeDir, '.pm2', 'logs', `${pc.name}-out.log`);
        const errLog = path.join(homeDir, '.pm2', 'logs', `${pc.name}-err.log`);

        this.watched.set(pc.id, {
          config: pc,
          pid: null,
          lastPidScan: 0,
          tailers: [
            new LogTailer(outLog, 'stdout'),
            new LogTailer(errLog, 'stderr'),
          ],
        });

        console.log(`[external] Watching: ${pc.name} (pattern: ${pc.match_pattern || pc.command})`);
      } else {
        existing.config = pc;
      }
    }
  }

  /**
   * Scan for PIDs, collect metrics, and read new log lines.
   * Returns { metrics: [...], logs: [...], events: [...] }
   */
  collect() {
    const metrics = [];
    const logs = [];
    const events = [];
    const now = Date.now();

    for (const [id, entry] of this.watched) {
      const pattern = entry.config.match_pattern || entry.config.command;

      // Re-scan for PID every 10 seconds or if we lost it
      if (!entry.pid || now - entry.lastPidScan > 10000) {
        const newPid = findPidByPattern(pattern);
        entry.lastPidScan = now;

        if (newPid && newPid !== entry.pid) {
          // Found a (new) PID
          if (!entry.pid) {
            console.log(`[external] Found ${entry.config.name} at PID ${newPid}`);
          }
          entry.pid = newPid;
        } else if (!newPid && entry.pid) {
          // Lost the PID
          console.log(`[external] Lost ${entry.config.name} (was PID ${entry.pid})`);
          events.push({
            process_id: id,
            kind: 'crash',
            exit_code: null,
            message: `Process disappeared (was PID ${entry.pid})`,
            time: new Date().toISOString(),
          });
          entry.pid = null;
        }
      }

      // Collect metrics if we have a PID
      if (entry.pid) {
        const m = getProcessMetrics(entry.pid);
        if (m) {
          metrics.push({
            process_id: id,
            cpu_pct: m.cpu_pct,
            mem_bytes: m.mem_bytes,
            time: new Date().toISOString(),
          });
        }
      }

      // Read new log lines
      for (const tailer of entry.tailers) {
        const newLines = tailer.readNewLines();
        for (const line of newLines) {
          logs.push({
            process_id: id,
            stream: line.stream,
            line: line.line,
            time: new Date().toISOString(),
          });
        }
      }
    }

    return { metrics, logs, events };
  }

  /**
   * Get status info for all watched processes.
   */
  getStatuses() {
    const statuses = [];
    for (const [id, entry] of this.watched) {
      statuses.push({
        process_id: id,
        name: entry.config.name,
        pid: entry.pid,
        status: entry.pid ? 'running' : 'stopped',
      });
    }
    return statuses;
  }
}
