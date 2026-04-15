import fs from 'fs';
import os from 'os';

// Track previous CPU stats for delta calculation
let prevCpuStat = null;

/**
 * Read overall system CPU percentage from /proc/stat.
 */
function getSystemCpuPct() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0];
    const parts = firstLine.split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((a, b) => a + b, 0);

    if (prevCpuStat) {
      const idleDelta = idle - prevCpuStat.idle;
      const totalDelta = total - prevCpuStat.total;
      prevCpuStat = { idle, total };
      if (totalDelta > 0) {
        return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
      }
    }
    prevCpuStat = { idle, total };
    return 0;
  } catch {
    return null;
  }
}

/**
 * Read memory usage from /proc/meminfo.
 */
function getMemoryInfo() {
  try {
    const info = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key) => {
      const m = info.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? parseInt(m[1]) * 1024 : 0;
    };
    const total = get('MemTotal');
    const available = get('MemAvailable');
    // Used = total - available (more accurate than total - free)
    return { total, used: total - available };
  } catch {
    return { total: 0, used: 0 };
  }
}

/**
 * Read disk usage for the root filesystem using statfs.
 */
function getDiskInfo() {
  return new Promise((resolve) => {
    try {
      fs.statfs('/', (err, stats) => {
        if (err) {
          resolve({ total: 0, used: 0 });
          return;
        }
        const total = stats.blocks * stats.bsize;
        const free = stats.bavail * stats.bsize;
        resolve({ total, used: total - free });
      });
    } catch {
      resolve({ total: 0, used: 0 });
    }
  });
}

/**
 * Read load averages from /proc/loadavg.
 */
function getLoadAvg() {
  try {
    const content = fs.readFileSync('/proc/loadavg', 'utf8');
    const parts = content.split(/\s+/);
    return {
      load_1min: parseFloat(parts[0]) || 0,
      load_5min: parseFloat(parts[1]) || 0,
      load_15min: parseFloat(parts[2]) || 0,
    };
  } catch {
    return { load_1min: 0, load_5min: 0, load_15min: 0 };
  }
}

/**
 * Collect all system metrics as one snapshot.
 */
export async function collectSystemMetrics() {
  const cpu_pct = getSystemCpuPct();
  const mem = getMemoryInfo();
  const disk = await getDiskInfo();
  const load = getLoadAvg();
  const uptime_seconds = Math.floor(os.uptime());
  const cpu_count = os.cpus().length;

  return {
    cpu_pct,
    mem_used_bytes: mem.used,
    mem_total_bytes: mem.total,
    disk_used_bytes: disk.used,
    disk_total_bytes: disk.total,
    ...load,
    uptime_seconds,
    cpu_count,
  };
}
