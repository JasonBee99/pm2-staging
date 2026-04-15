import fs from 'fs';
import os from 'os';

const prevCpuTimes = new Map();
const cpuCount = os.cpus().length;

export function getProcessMetrics(pid) {
  if (!pid) return null;
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const vmRssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
    const memBytes = vmRssMatch ? parseInt(vmRssMatch[1]) * 1024 : 0;

    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.replace(/^.*\)\s*/, '').split(/\s+/);
    const utime = parseInt(afterComm[11]) || 0;
    const stime = parseInt(afterComm[12]) || 0;
    const totalTicks = utime + stime;
    const now = Date.now();

    let cpuPct = 0;
    const prev = prevCpuTimes.get(pid);
    if (prev) {
      const tickDelta = totalTicks - prev.totalTicks;
      const timeDeltaSec = (now - prev.timestamp) / 1000;
      if (timeDeltaSec > 0) {
        cpuPct = (tickDelta / 100 / timeDeltaSec) * 100;
        cpuPct = Math.max(0, Math.min(cpuPct, 100 * cpuCount));
      }
    }
    prevCpuTimes.set(pid, { totalTicks, timestamp: now });
    return { cpu_pct: Math.round(cpuPct * 10) / 10, mem_bytes: memBytes };
  } catch {
    prevCpuTimes.delete(pid);
    return null;
  }
}

export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cleanupPid(pid) { prevCpuTimes.delete(pid); }

export function getSystemInfo() {
  return {
    hostname: os.hostname(),
    os_info: `${os.type()} ${os.release()} ${os.arch()}`,
    ip_address: getLocalIp(),
    agent_version: '1.0.0',
  };
}

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch {}
  return '0.0.0.0';
}
